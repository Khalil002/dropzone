using System.Security.Claims;
using System.Text.Json;
using Dapper;
using Npgsql;
using StackExchange.Redis;

namespace Dropzone.Api;

public sealed class DropRow
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public long PriceCents { get; set; }
    public int TotalStock { get; set; }
    public int RemainingStock { get; set; }
    public DateTime StartsAt { get; set; }
}

public sealed record DropDto(Guid Id, string Name, string Description, long PriceCents, int TotalStock,
    int RemainingStock, DateTime StartsAt, string Status)
{
    public static DropDto From(DropRow r) => new(r.Id, r.Name, r.Description, r.PriceCents, r.TotalStock,
        r.RemainingStock, r.StartsAt, Rules.DropStatus(r.RemainingStock, r.StartsAt, DateTime.UtcNow));
}

public sealed class DropRepository(NpgsqlDataSource db)
{
    private const string Columns = "id, name, description, price_cents, total_stock, remaining_stock, starts_at";

    public async Task<List<DropRow>> List()
    {
        await using var conn = await db.OpenConnectionAsync();
        return (await conn.QueryAsync<DropRow>($"SELECT {Columns} FROM drops ORDER BY starts_at DESC LIMIT 100")).ToList();
    }

    public async Task<DropRow?> Find(string id)
    {
        if (!Guid.TryParseExact(id, "D", out var guid)) return null;
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleOrDefaultAsync<DropRow>($"SELECT {Columns} FROM drops WHERE id = @guid", new { guid });
    }

    public async Task<DropRow> Create(string name, string description, long priceCents, int totalStock, DateTime startsAt)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleAsync<DropRow>(
            $"""
            INSERT INTO drops (name, description, price_cents, total_stock, remaining_stock, starts_at)
            VALUES (@name, @description, @priceCents, @totalStock, @totalStock, @startsAt) RETURNING {Columns}
            """, new { name, description, priceCents, totalStock, startsAt });
    }

    public async Task<List<Guid>> LiveWithStock()
    {
        await using var conn = await db.OpenConnectionAsync();
        return (await conn.QueryAsync<Guid>("SELECT id FROM drops WHERE starts_at <= now() AND remaining_stock > 0")).ToList();
    }
}

/// <summary>Per-user fixed-window limiter shared by the queue and checkout endpoints.</summary>
public sealed class RateLimiter(IConnectionMultiplexer redis, AppOptions options)
{
    public async Task Check(Guid userId)
    {
        var w = Rules.RateWindowAt(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), options.RateLimitWindowSec);
        var key = RedisKeys.RateLimit(userId, w.Window);
        var db = redis.GetDatabase();
        var count = await db.StringIncrementAsync(key);
        if (count == 1) await db.KeyExpireAsync(key, TimeSpan.FromSeconds(options.RateLimitWindowSec));
        if (count > options.RateLimitMax)
            throw new ApiException(429, "RATE_LIMITED", "Too many requests", null,
                new Dictionary<string, string> { ["Retry-After"] = w.RetryAfterSec.ToString() });
    }
}

/// <summary>Redis-backed virtual queue.</summary>
public sealed class WaitingRoom(IConnectionMultiplexer redis)
{
    public sealed record Status(string status, long? position);

    public async Task<bool> IsAdmitted(Guid dropId, Guid userId) =>
        await redis.GetDatabase().KeyExistsAsync(RedisKeys.Admitted(dropId, userId));

    /// <summary>
    /// Queue membership is checked before admission: the admitter writes the admission key
    /// before removing someone from the queue, so this order never misses a person.
    /// </summary>
    public async Task<Status?> Get(Guid dropId, Guid userId)
    {
        var rank = await redis.GetDatabase().SortedSetRankAsync(RedisKeys.Queue(dropId), userId.ToString());
        if (rank is not null) return new Status("waiting", rank + 1);
        return await IsAdmitted(dropId, userId) ? new Status("admitted", null) : null;
    }

    public async Task<Status> Join(Guid dropId, Guid userId)
    {
        if (await Get(dropId, userId) is { } existing) return existing;
        var db = redis.GetDatabase();
        // A monotonically increasing ticket gives strict first-come order.
        var ticket = await db.StringIncrementAsync(RedisKeys.QueueSeq(dropId));
        await db.SortedSetAddAsync(RedisKeys.Queue(dropId), userId.ToString(), ticket, When.NotExists);
        return (await Get(dropId, userId))!;
    }
}

/// <summary>Cache-aside for the drop list: served from Redis for CACHE_TTL_SEC, dropped on writes.</summary>
public sealed class DropCache(IConnectionMultiplexer redis, DropRepository drops, AppOptions options, JsonSerializerOptions json)
{
    public async Task<(string Json, bool Hit)> List()
    {
        var db = redis.GetDatabase();
        var cached = await db.StringGetAsync(RedisKeys.DropsCache);
        if (cached.HasValue) return (cached.ToString(), true);
        var body = JsonSerializer.Serialize((await drops.List()).Select(DropDto.From), json);
        await db.StringSetAsync(RedisKeys.DropsCache, body, TimeSpan.FromSeconds(options.CacheTtlSec));
        return (body, false);
    }

    public Task Invalidate() => redis.GetDatabase().KeyDeleteAsync(RedisKeys.DropsCache);
}

public static class DropEndpoints
{
    public sealed record NewDrop(string? Name, string? Description, long? PriceCents, int? TotalStock, string? StartsAt);

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/drops", List);
        api.MapPost("/drops", Create).RequireAuthorization("admin");
        api.MapGet("/drops/{dropId}", Get);
        api.MapPost("/drops/{dropId}/queue", Join).RequireAuthorization();
        api.MapGet("/drops/{dropId}/queue", QueueStatus).RequireAuthorization();
    }

    private static async Task<IResult> List(HttpContext ctx, DropCache cache)
    {
        var (json, hit) = await cache.List();
        ctx.Response.Headers["X-Cache"] = hit ? "HIT" : "MISS";
        return Results.Content(json, "application/json");
    }

    private static async Task<IResult> Create(NewDrop body, DropRepository drops, DropCache cache)
    {
        var problems = new List<string>();
        var name = body.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 120) problems.Add("name: must be 1-120 characters");
        if (body.Description is { Length: > 2000 }) problems.Add("description: at most 2000 characters");
        if (body.PriceCents is not >= 1) problems.Add("priceCents: must be at least 1");
        if (body.TotalStock is not (>= 1 and <= 1_000_000)) problems.Add("totalStock: must be 1-1000000");
        if (!Rules.TryParseTimestamp(body.StartsAt, out var startsAt)) problems.Add("startsAt: must be an ISO 8601 date-time");
        if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));

        var row = await drops.Create(name, body.Description ?? "", body.PriceCents!.Value, body.TotalStock!.Value, startsAt);
        await cache.Invalidate();
        return Results.Json(DropDto.From(row), statusCode: 201);
    }

    private static async Task<IResult> Get(string dropId, DropRepository drops) =>
        await drops.Find(dropId) is { } row ? Results.Ok(DropDto.From(row)) : throw ApiException.NotFound("Drop");

    private static async Task<IResult> Join(string dropId, ClaimsPrincipal user, DropRepository drops,
        WaitingRoom room, RateLimiter limiter)
    {
        var userId = CurrentUser.Id(user);
        await limiter.Check(userId);
        var drop = await drops.Find(dropId) ?? throw ApiException.NotFound("Drop");
        return Results.Ok(await room.Join(drop.Id, userId));
    }

    private static async Task<IResult> QueueStatus(string dropId, ClaimsPrincipal user, DropRepository drops, WaitingRoom room)
    {
        var drop = await drops.Find(dropId) ?? throw ApiException.NotFound("Drop");
        return await room.Get(drop.Id, CurrentUser.Id(user)) is { } status
            ? Results.Ok(status)
            : throw new ApiException(404, "NOT_IN_QUEUE", "You have not joined this drop's queue");
    }
}
