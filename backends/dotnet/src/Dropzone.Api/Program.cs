using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Dropzone.Api;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using StackExchange.Redis;

var options = AppOptions.FromEnvironment();
DefaultTypeMap.MatchNamesWithUnderscores = true;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{options.Port}");
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
json.Converters.Add(new UtcMillisConverter());
builder.Services.Configure<JsonOptions>(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.Converters.Add(new UtcMillisConverter());
});
builder.Services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);

builder.Services.AddSingleton(options);
builder.Services.AddSingleton(json);
builder.Services.AddSingleton(NpgsqlDataSource.Create(options.ConnectionString));
builder.Services.AddSingleton<IConnectionMultiplexer>(
    ConnectionMultiplexer.Connect($"{options.RedisHost}:{options.RedisPort},abortConnect=false"));
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<DropRepository>();
builder.Services.AddSingleton<DropCache>();
builder.Services.AddSingleton<WaitingRoom>();
builder.Services.AddSingleton<RateLimiter>();
builder.Services.AddSingleton<CheckoutService>();
builder.Services.AddSingleton<Rabbit>();
builder.Services.AddHostedService<Admitter>();
builder.Services.AddHostedService<OutboxPublisher>();
builder.Services.AddHostedService<NotificationConsumer>();

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false; // keep "sub" and "role" as-is
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = TokenService.Issuer,
            ValidateAudience = false,
            IssuerSigningKey = TokenService.SigningKey(options),
            ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            RoleClaimType = "role",
            NameClaimType = "email",
            ClockSkew = TimeSpan.FromSeconds(5),
        };
        o.Events = new JwtBearerEvents
        {
            OnChallenge = ctx =>
            {
                ctx.HandleResponse();
                return Problems.Write(ctx.HttpContext, 401, "UNAUTHORIZED", "Missing, invalid or expired token");
            },
            OnForbidden = ctx => Problems.Write(ctx.HttpContext, 403, "FORBIDDEN", "Your role cannot do this"),
        };
    });
builder.Services.AddAuthorizationBuilder().AddPolicy("admin", p => p.RequireRole("admin"));

var app = builder.Build();
app.Use(Problems.Middleware);
app.UseAuthentication();
app.UseAuthorization();

var api = app.MapGroup("/api");
api.MapGet("/health", async (NpgsqlDataSource db, IConnectionMultiplexer redis) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        await redis.GetDatabase().PingAsync();
        return Results.Ok(new { status = "ok", backend = "dotnet" });
    }
    catch
    {
        return Results.Json(new { status = "degraded", backend = "dotnet" }, statusCode: 503);
    }
});
AuthEndpoints.Map(api);
DropEndpoints.Map(api);
OrderEndpoints.Map(api);
api.MapFallback(() => { throw ApiException.NotFound("Route"); });

app.Run();

/// <summary>Writes timestamps as UTC ISO 8601 with millisecond precision, like the other backends.</summary>
internal sealed class UtcMillisConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime().ToUniversalTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
}
