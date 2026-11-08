using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Dropzone.Api;

/// <summary>Pure business rules, identical in every backend.</summary>
public static partial class Rules
{
    /// <summary>sold_out wins over everything; otherwise a drop is live once it has started.</summary>
    public static string DropStatus(int remainingStock, DateTime startsAt, DateTime now) =>
        remainingStock <= 0 ? "sold_out" : startsAt > now ? "upcoming" : "live";

    /// <summary>Fingerprint of a checkout body for Idempotency-Key reuse detection.</summary>
    public static string CheckoutRequestHash(Guid dropId, int quantity)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{dropId.ToString().ToLowerInvariant()}|{quantity}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public readonly record struct RateWindow(long Window, long RetryAfterSec);

    /// <summary>Fixed-window rate limiting: the current window and seconds until it resets.</summary>
    public static RateWindow RateWindowAt(long nowMs, int windowSec)
    {
        var nowSec = nowMs / 1000;
        var window = nowSec / windowSec;
        return new RateWindow(window, Math.Max(1, (window + 1) * windowSec - nowSec));
    }

    public static long OrderTotal(long priceCents, int quantity) => priceCents * quantity;

    public static string NotificationMessage(int quantity, string dropName) => $"Order confirmed: {quantity} x {dropName}";

    public static bool IsValidIdempotencyKey(string? key) => key is { Length: >= 8 and <= 128 };

    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]+$")]
    private static partial Regex EmailRegex();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$")]
    private static partial Regex IsoTimestampRegex();

    public static bool IsEmail(string value) => value.Length <= 254 && EmailRegex().IsMatch(value);

    public static bool TryParseTimestamp(string? value, out DateTime utc)
    {
        utc = default;
        if (value is null || !IsoTimestampRegex().IsMatch(value)) return false;
        if (!DateTimeOffset.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)) return false;
        utc = parsed.UtcDateTime;
        return true;
    }
}
