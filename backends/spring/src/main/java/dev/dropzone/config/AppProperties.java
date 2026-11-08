package dev.dropzone.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtSecret,
        long jwtTtlSec,
        long signupCreditCents,
        int admitBatch,
        long admitIntervalMs,
        long admissionTtlSec,
        int rateLimitMax,
        int rateLimitWindowSec,
        long cacheTtlSec) {

    public static final java.util.UUID PROMO_ACCOUNT_ID = java.util.UUID.fromString("00000000-0000-0000-0000-000000000001");
    public static final java.util.UUID REVENUE_ACCOUNT_ID = java.util.UUID.fromString("00000000-0000-0000-0000-000000000002");
}
