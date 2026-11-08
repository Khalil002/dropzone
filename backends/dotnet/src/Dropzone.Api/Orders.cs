using System.Data;
using System.Security.Claims;
using System.Text.Json;
using Dapper;
using Npgsql;

namespace Dropzone.Api;

public sealed class OrderRow
{
    public Guid Id { get; set; }
    public Guid DropId { get; set; }
    public int Quantity { get; set; }
    public long TotalCents { get; set; }
    public string Status { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public sealed class StoredResponse
{
    public string RequestHash { get; set; } = "";
    public int ResponseStatus { get; set; }
    public string ResponseBody { get; set; } = "";
}

public sealed class CheckoutService(NpgsqlDataSource db, JsonSerializerOptions json)
{
    private const string StoredSql =
        "SELECT request_hash, response_status, response_body::text AS response_body FROM idempotency_keys WHERE user_id = @userId AND key = @key";

    public async Task<StoredResponse?> Stored(Guid userId, string key)
    {
        await using var conn = await db.OpenConnectionAsync();
        return await conn.QuerySingleOrDefaultAsync<StoredResponse>(StoredSql, new { userId, key });
    }

    /// <summary>
    /// One database transaction: conditional stock decrement, wallet debit under a row lock,
    /// balanced ledger legs, the order, an outbox event and the stored idempotent response.
    /// Returns either the new order JSON or the response a concurrent request stored first.
    /// </summary>
    public async Task<(string? Body, StoredResponse? Raced)> Checkout(Guid userId, string key, string requestHash, Guid dropId, int quantity)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted);

        // Serialise concurrent requests sharing a key, then re-check for a stored response.
        await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtext(@u || ':' || @key))", new { u = userId.ToString(), key }, tx);
        var raced = await conn.QuerySingleOrDefaultAsync<StoredResponse>(StoredSql, new { userId, key }, tx);
        if (raced is not null) return (null, raced);

        if (await conn.ExecuteScalarAsync<int?>("SELECT 1 FROM orders WHERE user_id = @userId AND drop_id = @dropId", new { userId, dropId }, tx) is not null)
            throw AlreadyOrdered();

        // Conditional decrement: never oversells, even under heavy concurrency.
        var stock = await conn.QuerySingleOrDefaultAsync<StockRow>(
            "UPDATE drops SET remaining_stock = remaining_stock - @quantity WHERE id = @dropId AND remaining_stock >= @quantity RETURNING price_cents, name",
            new { dropId, quantity }, tx) ?? throw new ApiException(409, "SOLD_OUT", "Not enough stock left");
        var total = Rules.OrderTotal(stock.PriceCents, quantity);

        // Lock the wallet row so concurrent purchases cannot both spend the same balance.
        var wallet = await conn.QuerySingleOrDefaultAsync<WalletRow>(
            "SELECT id, balance_cents FROM accounts WHERE user_id = @userId FOR UPDATE", new { userId }, tx);
        if (wallet is null || wallet.BalanceCents < total)
            throw new ApiException(402, "INSUFFICIENT_FUNDS", "Wallet balance is too low");
        var walletId = wallet.Id;

        OrderRow order;
        try
        {
            order = await conn.QuerySingleAsync<OrderRow>(
                "INSERT INTO orders (user_id, drop_id, quantity, total_cents) VALUES (@userId, @dropId, @quantity, @total) RETURNING id, drop_id, quantity, total_cents, status, created_at",
                new { userId, dropId, quantity, total }, tx);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw AlreadyOrdered();
        }

        var txId = await conn.QuerySingleAsync<Guid>(
            "INSERT INTO ledger_transactions (kind, reference_id) VALUES ('purchase', @id) RETURNING id", new { id = order.Id }, tx);
        await conn.ExecuteAsync(
            "INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES (@txId, @walletId, @debit), (@txId, @revenue, @total)",
            new { txId, walletId, debit = -total, revenue = AppOptions.RevenueAccountId, total }, tx);
        await conn.ExecuteAsync("UPDATE accounts SET balance_cents = balance_cents - @total WHERE id = @walletId", new { total, walletId }, tx);
        await conn.ExecuteAsync("UPDATE accounts SET balance_cents = balance_cents + @total WHERE id = @revenue",
            new { total, revenue = AppOptions.RevenueAccountId }, tx);

        var payload = JsonSerializer.Serialize(new { orderId = order.Id, userId, dropId, dropName = stock.Name, quantity, totalCents = total });
        await conn.ExecuteAsync("INSERT INTO outbox_events (event_type, payload) VALUES ('order.confirmed', @payload::jsonb)", new { payload }, tx);

        var body = JsonSerializer.Serialize(order, json);
        await conn.ExecuteAsync(
            "INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body) VALUES (@userId, @key, @requestHash, 201, @body::jsonb)",
            new { userId, key, requestHash, body }, tx);
        await tx.CommitAsync();
        return (body, null);
    }

    private sealed class StockRow
    {
        public long PriceCents { get; set; }
        public string Name { get; set; } = "";
    }

    private sealed class WalletRow
    {
        public Guid Id { get; set; }
        public long BalanceCents { get; set; }
    }

    private static ApiException AlreadyOrdered() => new(409, "ALREADY_ORDERED", "You already bought this drop");
}

public static class OrderEndpoints
{
    public sealed record CheckoutRequest(Guid? DropId, int? Quantity);

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/orders", List).RequireAuthorization();
        api.MapPost("/orders", Create).RequireAuthorization();
    }

    private static async Task<IResult> List(ClaimsPrincipal user, NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var rows = await conn.QueryAsync<OrderRow>(
            "SELECT id, drop_id, quantity, total_cents, status, created_at FROM orders WHERE user_id = @id ORDER BY created_at DESC LIMIT 100",
            new { id = CurrentUser.Id(user) });
        return Results.Ok(rows);
    }

    private static async Task<IResult> Create(HttpContext ctx, ClaimsPrincipal user, CheckoutRequest body,
        CheckoutService checkout, DropRepository drops, DropCache cache, WaitingRoom room, RateLimiter limiter)
    {
        var userId = CurrentUser.Id(user);
        await limiter.Check(userId);
        string? key = ctx.Request.Headers["Idempotency-Key"];
        if (!Rules.IsValidIdempotencyKey(key))
            throw new ApiException(400, "IDEMPOTENCY_KEY_MISSING", "Idempotency-Key header (8-128 chars) is required");
        if (body.DropId is null || body.Quantity is not (>= 1 and <= 2))
            throw ApiException.Validation("dropId: required uuid; quantity: must be 1 or 2");
        var dropId = body.DropId.Value;
        var quantity = body.Quantity.Value;
        var requestHash = Rules.CheckoutRequestHash(dropId, quantity);

        if (await checkout.Stored(userId, key!) is { } earlier) return Replay(ctx, earlier, requestHash);

        var drop = await drops.Find(dropId.ToString()) ?? throw ApiException.NotFound("Drop");
        if (DropDto.From(drop).Status == "upcoming")
            throw new ApiException(409, "DROP_NOT_LIVE", "This drop has not started yet");
        if (!await room.IsAdmitted(drop.Id, userId))
            throw new ApiException(403, "NOT_ADMITTED", "Wait in the queue until you are admitted");

        var (created, raced) = await checkout.Checkout(userId, key!, requestHash, drop.Id, quantity);
        if (raced is not null) return Replay(ctx, raced, requestHash);
        await cache.Invalidate();
        return Results.Content(created, "application/json", statusCode: 201);
    }

    private static IResult Replay(HttpContext ctx, StoredResponse stored, string requestHash)
    {
        if (stored.RequestHash != requestHash)
            throw new ApiException(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different body");
        ctx.Response.Headers["Idempotent-Replayed"] = "true";
        return Results.Content(stored.ResponseBody, "application/json", statusCode: stored.ResponseStatus);
    }
}
