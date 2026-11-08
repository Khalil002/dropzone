package dev.dropzone.drops;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.dropzone.config.AppProperties;
import dev.dropzone.config.RedisKeys;
import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/** Cache-aside for the drop list: served from Redis for CACHE_TTL_SEC, dropped on writes. */
@Component
public class DropCache {
    private final StringRedisTemplate redis;
    private final DropRepository drops;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public DropCache(StringRedisTemplate redis, DropRepository drops, ObjectMapper mapper, AppProperties props) {
        this.redis = redis;
        this.drops = drops;
        this.mapper = mapper;
        this.props = props;
    }

    public record Cached(String json, boolean hit) {}

    public Cached list() throws JsonProcessingException {
        String cached = redis.opsForValue().get(RedisKeys.DROPS_CACHE);
        if (cached != null) return new Cached(cached, true);
        String json = mapper.writeValueAsString(drops.list());
        redis.opsForValue().set(RedisKeys.DROPS_CACHE, json, Duration.ofSeconds(props.cacheTtlSec()));
        return new Cached(json, false);
    }

    public void invalidate() {
        redis.delete(RedisKeys.DROPS_CACHE);
    }
}
