package dev.dropzone.orders;

import java.time.Instant;
import java.util.UUID;

public record Order(UUID id, UUID dropId, int quantity, long totalCents, String status, Instant createdAt) {}
