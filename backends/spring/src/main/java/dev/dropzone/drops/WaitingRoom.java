package dev.dropzone.drops;

import dev.dropzone.config.AppProperties;
import dev.dropzone.config.RedisKeys;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Redis-backed virtual queue plus the background admitter that lets people in. */
@Component
public class WaitingRoom {
    private static final Logger log = LoggerFactory.getLogger(WaitingRoom.class);
    private final StringRedisTemplate redis;
    private final DropRepository drops;
    private final AppProperties props;

    public WaitingRoom(StringRedisTemplate redis, DropRepository drops, AppProperties props) {
        this.redis = redis;
        this.drops = drops;
        this.props = props;
    }

    public boolean isAdmitted(UUID dropId, UUID userId) {
        return Boolean.TRUE.equals(redis.hasKey(RedisKeys.admitted(dropId, userId)));
    }

    /**
     * Queue membership is checked before admission: the admitter writes the admission key
     * before removing someone from the queue, so this order never misses a person.
     */
    public Optional<Map<String, Object>> status(UUID dropId, UUID userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        Long rank = redis.opsForZSet().rank(RedisKeys.queue(dropId), userId.toString());
        if (rank != null) {
            body.put("status", "waiting");
            body.put("position", rank + 1);
            return Optional.of(body);
        }
        if (isAdmitted(dropId, userId)) {
            body.put("status", "admitted");
            body.put("position", null);
            return Optional.of(body);
        }
        return Optional.empty();
    }

    public Map<String, Object> join(UUID dropId, UUID userId) {
        return status(dropId, userId).orElseGet(() -> {
            // A monotonically increasing ticket gives strict first-come order.
            Long ticket = redis.opsForValue().increment(RedisKeys.queueSeq(dropId));
            redis.opsForZSet().addIfAbsent(RedisKeys.queue(dropId), userId.toString(), ticket);
            return status(dropId, userId).orElseThrow();
        });
    }

    /**
     * Admits the head of each live queue. The admission key is written before the member
     * leaves the queue, so a poll never sees someone as neither waiting nor admitted.
     * Running this on several instances at once is harmless: admitting twice is a no-op.
     */
    @Scheduled(fixedDelayString = "${app.admit-interval-ms}")
    public void admit() {
        try {
            for (UUID dropId : drops.liveWithStock()) {
                String queue = RedisKeys.queue(dropId);
                Set<String> head = redis.opsForZSet().range(queue, 0, props.admitBatch() - 1);
                if (head == null || head.isEmpty()) continue;
                for (String userId : head) {
                    redis.opsForValue().set(RedisKeys.admitted(dropId, UUID.fromString(userId)), "1",
                            Duration.ofSeconds(props.admissionTtlSec()));
                }
                redis.opsForZSet().remove(queue, head.toArray());
            }
        } catch (Exception e) {
            log.warn("admitter tick failed: {}", e.getMessage());
        }
    }
}
