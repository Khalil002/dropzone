package dev.dropzone;

import static org.assertj.core.api.Assertions.assertThat;

import dev.dropzone.domain.Rules;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RulesTest {
    private static final Instant NOW = Instant.parse("2026-01-01T12:00:00Z");

    @Test
    void soldOutWinsOverStartTime() {
        assertThat(Rules.dropStatus(0, Instant.parse("2027-01-01T00:00:00Z"), NOW)).isEqualTo("sold_out");
    }

    @Test
    void upcomingBeforeStartLiveFromStart() {
        assertThat(Rules.dropStatus(5, NOW.plusSeconds(1), NOW)).isEqualTo("upcoming");
        assertThat(Rules.dropStatus(5, NOW, NOW)).isEqualTo("live");
    }

    @Test
    void checkoutHashMatchesTheOtherBackends() {
        UUID id = UUID.fromString("00000000-0000-0000-0000-000000000ABC");
        assertThat(Rules.checkoutRequestHash(id, 2))
                .isEqualTo("29a1d8a96621022b392fc68a5458ca86d949f47552fcc41265514498316a5ffa");
        assertThat(Rules.checkoutRequestHash(id, 1)).isNotEqualTo(Rules.checkoutRequestHash(id, 2));
    }

    @Test
    void rateWindowsAreFixedBuckets() {
        assertThat(Rules.rateWindow(100_000, 10)).isEqualTo(new Rules.RateWindow(10, 10));
        assertThat(Rules.rateWindow(109_500, 10)).isEqualTo(new Rules.RateWindow(10, 1));
        assertThat(Rules.rateWindow(110_000, 10).window()).isEqualTo(11);
    }

    @Test
    void smallHelpers() {
        assertThat(Rules.orderTotal(7500, 2)).isEqualTo(15000);
        assertThat(Rules.notificationMessage(1, "Runner")).isEqualTo("Order confirmed: 1 x Runner");
        assertThat(Rules.isUuid("9b2c1e0a-1111-4222-8333-444455556666")).isTrue();
        assertThat(Rules.isUuid("nope")).isFalse();
        assertThat(Rules.isValidIdempotencyKey("short")).isFalse();
        assertThat(Rules.isValidIdempotencyKey("long-enough")).isTrue();
        assertThat(Rules.isValidIdempotencyKey("x".repeat(129))).isFalse();
    }
}
