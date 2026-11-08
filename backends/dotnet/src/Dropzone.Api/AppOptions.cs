namespace Dropzone.Api;

/// <summary>Settings read from the same environment variables every backend uses.</summary>
public sealed record AppOptions
{
    public int Port { get; init; } = 8000;
    public string ConnectionString { get; init; } = "";
    public string RedisHost { get; init; } = "localhost";
    public int RedisPort { get; init; } = 6379;
    public string RabbitHost { get; init; } = "localhost";
    public int RabbitPort { get; init; } = 5672;
    public string RabbitUser { get; init; } = "guest";
    public string RabbitPassword { get; init; } = "guest";
    public string JwtSecret { get; init; } = "change-me-to-a-long-random-secret-of-32-bytes";
    public int JwtTtlSec { get; init; } = 3600;
    public long SignupCreditCents { get; init; } = 50000;
    public int AdmitBatch { get; init; } = 50;
    public int AdmitIntervalMs { get; init; } = 1000;
    public int AdmissionTtlSec { get; init; } = 600;
    public int RateLimitMax { get; init; } = 20;
    public int RateLimitWindowSec { get; init; } = 10;
    public int CacheTtlSec { get; init; } = 2;

    public static readonly Guid PromoAccountId = Guid.Parse("00000000-0000-0000-0000-000000000001");
    public static readonly Guid RevenueAccountId = Guid.Parse("00000000-0000-0000-0000-000000000002");

    public static AppOptions FromEnvironment()
    {
        static string Str(string name, string fallback) =>
            Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;
        static int Int(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

        var db = $"Host={Str("DB_HOST", "localhost")};Port={Int("DB_PORT", 5432)};Database={Str("DB_NAME", "dropzone")};" +
                 $"Username={Str("DB_USER", "dropzone")};Password={Str("DB_PASSWORD", "dropzone")};Maximum Pool Size=20";
        return new AppOptions
        {
            Port = Int("PORT", 8000),
            ConnectionString = db,
            RedisHost = Str("REDIS_HOST", "localhost"),
            RedisPort = Int("REDIS_PORT", 6379),
            RabbitHost = Str("RABBITMQ_HOST", "localhost"),
            RabbitPort = Int("RABBITMQ_PORT", 5672),
            RabbitUser = Str("RABBITMQ_USER", "guest"),
            RabbitPassword = Str("RABBITMQ_PASSWORD", "guest"),
            JwtSecret = Str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
            JwtTtlSec = Int("JWT_TTL_SEC", 3600),
            SignupCreditCents = Int("SIGNUP_CREDIT_CENTS", 50000),
            AdmitBatch = Int("ADMIT_BATCH", 50),
            AdmitIntervalMs = Int("ADMIT_INTERVAL_MS", 1000),
            AdmissionTtlSec = Int("ADMISSION_TTL_SEC", 600),
            RateLimitMax = Int("RATE_LIMIT_MAX", 20),
            RateLimitWindowSec = Int("RATE_LIMIT_WINDOW_SEC", 10),
            CacheTtlSec = Int("CACHE_TTL_SEC", 2),
        };
    }
}

/// <summary>Redis key names shared by all three backends.</summary>
public static class RedisKeys
{
    public const string DropsCache = "dz:cache:drops";
    public static string Queue(Guid dropId) => $"dz:queue:{dropId}";
    public static string QueueSeq(Guid dropId) => $"dz:queue:{dropId}:seq";
    public static string Admitted(Guid dropId, Guid userId) => $"dz:admitted:{dropId}:{userId}";
    public static string RateLimit(Guid userId, long window) => $"dz:rl:{userId}:{window}";
}
