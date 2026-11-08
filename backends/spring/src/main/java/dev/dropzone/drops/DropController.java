package dev.dropzone.drops;

import com.fasterxml.jackson.core.JsonProcessingException;
import dev.dropzone.auth.CurrentUser;
import dev.dropzone.web.ApiException;
import dev.dropzone.web.ErrorCode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/drops")
public class DropController {
    private final DropRepository drops;
    private final DropCache cache;
    private final WaitingRoom waitingRoom;
    private final RateLimiter rateLimiter;

    public DropController(DropRepository drops, DropCache cache, WaitingRoom waitingRoom, RateLimiter rateLimiter) {
        this.drops = drops;
        this.cache = cache;
        this.waitingRoom = waitingRoom;
        this.rateLimiter = rateLimiter;
    }

    public record NewDrop(
            @NotBlank @Size(max = 120) String name,
            @Size(max = 2000) String description,
            @NotNull @Min(1) Long priceCents,
            @NotNull @Min(1) @Max(1_000_000) Integer totalStock,
            @NotNull OffsetDateTime startsAt) {}

    @GetMapping
    public ResponseEntity<String> list() throws JsonProcessingException {
        DropCache.Cached result = cache.list();
        return ResponseEntity.ok()
                .header("X-Cache", result.hit() ? "HIT" : "MISS")
                .contentType(MediaType.APPLICATION_JSON)
                .body(result.json());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Drop create(@Valid @RequestBody NewDrop body) {
        Drop drop = drops.create(body.name().trim(), body.description() == null ? "" : body.description(),
                body.priceCents(), body.totalStock(), body.startsAt());
        cache.invalidate();
        return drop;
    }

    @GetMapping("/{dropId}")
    public Drop get(@PathVariable String dropId) {
        return drops.find(dropId).orElseThrow(() -> ApiException.notFound("Drop"));
    }

    @PostMapping("/{dropId}/queue")
    public Map<String, Object> join(@PathVariable String dropId, @AuthenticationPrincipal Jwt jwt) {
        UUID userId = CurrentUser.id(jwt);
        rateLimiter.check(userId);
        Drop drop = drops.find(dropId).orElseThrow(() -> ApiException.notFound("Drop"));
        return waitingRoom.join(drop.id(), userId);
    }

    @GetMapping("/{dropId}/queue")
    public Map<String, Object> queueStatus(@PathVariable String dropId, @AuthenticationPrincipal Jwt jwt) {
        Drop drop = drops.find(dropId).orElseThrow(() -> ApiException.notFound("Drop"));
        return waitingRoom.status(drop.id(), CurrentUser.id(jwt)).orElseThrow(() ->
                new ApiException(404, ErrorCode.NOT_IN_QUEUE, "You have not joined this drop's queue"));
    }
}
