package dev.dropzone.drops;

import dev.dropzone.config.AppProperties;
import dev.dropzone.config.RedisKeys;
import dev.dropzone.domain.Rules;
import dev.dropzone.web.ApiException;
import dev.dropzone.web.ErrorCode;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/** Per-user fixed-window limiter shared by the queue and checkout endpoints. */
@Component
public class RateLimiter {
    private final StringRedisTemplate redis;
    private final AppProperties props;

    public RateLimiter(StringRedisTemplate redis, AppProperties props) {
        this.redis = redis;
        this.props = props;
    }

    public void check(UUID userId) {
        Rules.RateWindow w = Rules.rateWindow(System.currentTimeMillis(), props.rateLimitWindowSec());
        String key = RedisKeys.rateLimit(userId, w.window());
        Long count = redis.opsForValue().increment(key);
        if (count != null && count == 1) redis.expire(key, Duration.ofSeconds(props.rateLimitWindowSec()));
        if (count != null && count > props.rateLimitMax()) {
            throw new ApiException(429, ErrorCode.RATE_LIMITED, "Too many requests", null,
                    Map.of("Retry-After", String.valueOf(w.retryAfterSec())));
        }
    }
}
