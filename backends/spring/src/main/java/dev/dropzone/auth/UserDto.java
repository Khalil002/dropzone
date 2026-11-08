package dev.dropzone.auth;

import java.util.UUID;

public record UserDto(UUID id, String email, String role) {}
