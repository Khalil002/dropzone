package dev.dropzone.config;

import java.util.UUID;

/** Redis key names shared by all three backends. */
public final class RedisKeys {
    private RedisKeys() {}

    public static final String DROPS_CACHE = "dz:cache:drops";

    public static String queue(UUID dropId) { return "dz:queue:" + dropId; }
    public static String queueSeq(UUID dropId) { return "dz:queue:" + dropId + ":seq"; }
    public static String admitted(UUID dropId, UUID userId) { return "dz:admitted:" + dropId + ":" + userId; }
    public static String rateLimit(UUID userId, long window) { return "dz:rl:" + userId + ":" + window; }
}
