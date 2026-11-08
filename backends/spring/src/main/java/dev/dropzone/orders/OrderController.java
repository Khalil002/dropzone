package dev.dropzone.orders;

import dev.dropzone.auth.CurrentUser;
import dev.dropzone.domain.Rules;
import dev.dropzone.drops.Drop;
import dev.dropzone.drops.DropCache;
import dev.dropzone.drops.DropRepository;
import dev.dropzone.drops.RateLimiter;
import dev.dropzone.drops.WaitingRoom;
import dev.dropzone.web.ApiException;
import dev.dropzone.web.ErrorCode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private final JdbcClient db;
    private final CheckoutService checkout;
    private final DropRepository drops;
    private final DropCache cache;
    private final WaitingRoom waitingRoom;
    private final RateLimiter rateLimiter;

    public OrderController(JdbcClient db, CheckoutService checkout, DropRepository drops, DropCache cache,
                           WaitingRoom waitingRoom, RateLimiter rateLimiter) {
        this.db = db;
        this.checkout = checkout;
        this.drops = drops;
        this.cache = cache;
        this.waitingRoom = waitingRoom;
        this.rateLimiter = rateLimiter;
    }

    public record CheckoutRequest(@NotNull UUID dropId, @NotNull @Min(1) @Max(2) Integer quantity) {}

    @GetMapping
    public List<Order> list(@AuthenticationPrincipal Jwt jwt) {
        return db.sql("SELECT id, drop_id, quantity, total_cents, status, created_at FROM orders "
                        + "WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
                .param(CurrentUser.id(jwt))
                .query((rs, i) -> new Order(rs.getObject("id", UUID.class), rs.getObject("drop_id", UUID.class),
                        rs.getInt("quantity"), rs.getLong("total_cents"), rs.getString("status"),
                        rs.getTimestamp("created_at").toInstant().truncatedTo(ChronoUnit.MILLIS)))
                .list();
    }

    @PostMapping
    public ResponseEntity<String> create(@AuthenticationPrincipal Jwt jwt,
                                         @RequestHeader(value = "Idempotency-Key", required = false) String key,
                                         @Valid @RequestBody CheckoutRequest body) {
        UUID userId = CurrentUser.id(jwt);
        rateLimiter.check(userId);
        if (!Rules.isValidIdempotencyKey(key)) {
            throw new ApiException(400, ErrorCode.IDEMPOTENCY_KEY_MISSING,
                    "Idempotency-Key header (8-128 chars) is required");
        }
        String requestHash = Rules.checkoutRequestHash(body.dropId(), body.quantity());

        Optional<CheckoutService.StoredResponse> earlier = checkout.stored(userId, key);
        if (earlier.isPresent()) return replay(earlier.get(), requestHash);

        Drop drop = drops.find(body.dropId().toString()).orElseThrow(() -> ApiException.notFound("Drop"));
        if ("upcoming".equals(drop.status())) {
            throw new ApiException(409, ErrorCode.DROP_NOT_LIVE, "This drop has not started yet");
        }
        if (!waitingRoom.isAdmitted(drop.id(), userId)) {
            throw new ApiException(403, ErrorCode.NOT_ADMITTED, "Wait in the queue until you are admitted");
        }

        CheckoutService.Outcome outcome = checkout.checkout(userId, key, requestHash, drop.id(), body.quantity());
        if (outcome.raced() != null) return replay(outcome.raced(), requestHash);
        cache.invalidate();
        return ResponseEntity.status(201).contentType(MediaType.APPLICATION_JSON).body(outcome.body());
    }

    private static ResponseEntity<String> replay(CheckoutService.StoredResponse stored, String requestHash) {
        if (!stored.requestHash().equals(requestHash)) {
            throw new ApiException(422, ErrorCode.IDEMPOTENCY_KEY_REUSED,
                    "Idempotency-Key was already used with a different body");
        }
        return ResponseEntity.status(stored.status()).header("Idempotent-Replayed", "true")
                .contentType(MediaType.APPLICATION_JSON).body(stored.body());
    }
}
