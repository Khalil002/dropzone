package dev.dropzone.drops;

import dev.dropzone.domain.Rules;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

public record Drop(UUID id, String name, String description, long priceCents, int totalStock,
                   int remainingStock, Instant startsAt, String status) {

    public static Drop of(UUID id, String name, String description, long priceCents, int totalStock,
                          int remainingStock, Instant startsAt) {
        Instant start = startsAt.truncatedTo(ChronoUnit.MILLIS);
        return new Drop(id, name, description, priceCents, totalStock, remainingStock, start,
                Rules.dropStatus(remainingStock, start, Instant.now()));
    }
}
