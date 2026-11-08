package dev.dropzone.domain;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** Pure business rules, identical in every backend. */
public final class Rules {
    private Rules() {}

    private static final Pattern UUID_RE =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    /** sold_out wins over everything; otherwise a drop is live once it has started. */
    public static String dropStatus(int remainingStock, Instant startsAt, Instant now) {
        if (remainingStock <= 0) return "sold_out";
        return startsAt.isAfter(now) ? "upcoming" : "live";
    }

    /** Fingerprint of a checkout body for Idempotency-Key reuse detection. */
    public static String checkoutRequestHash(UUID dropId, int quantity) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest((dropId.toString().toLowerCase(Locale.ROOT) + "|" + quantity).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public record RateWindow(long window, long retryAfterSec) {}

    /** Fixed-window rate limiting: the current window and seconds until it resets. */
    public static RateWindow rateWindow(long nowMs, int windowSec) {
        long nowSec = Math.floorDiv(nowMs, 1000);
        long window = Math.floorDiv(nowSec, windowSec);
        long retryAfter = Math.max(1, (window + 1) * windowSec - nowSec);
        return new RateWindow(window, retryAfter);
    }

    public static long orderTotal(long priceCents, int quantity) {
        return priceCents * quantity;
    }

    public static String notificationMessage(int quantity, String dropName) {
        return "Order confirmed: " + quantity + " x " + dropName;
    }

    public static boolean isUuid(String value) {
        return value != null && UUID_RE.matcher(value).matches();
    }

    public static boolean isValidIdempotencyKey(String key) {
        return key != null && key.length() >= 8 && key.length() <= 128;
    }
}
