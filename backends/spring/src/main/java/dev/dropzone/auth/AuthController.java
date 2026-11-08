package dev.dropzone.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService auth;
    private final TokenService tokens;

    public AuthController(AuthService auth, TokenService tokens) {
        this.auth = auth;
        this.tokens = tokens;
    }

    public record Credentials(
            @NotNull @Size(max = 254) @Pattern(regexp = "^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$", message = "must be an email address")
            String email,
            @NotNull @Size(min = 8, max = 72) String password) {

        String normalisedEmail() {
            return email.trim().toLowerCase(Locale.ROOT);
        }
    }

    public record LoginRequest(String email, String password) {}

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> register(@Valid @RequestBody Credentials body) {
        UserDto user = auth.register(body.normalisedEmail(), body.password());
        return Map.of("token", tokens.issue(user), "user", user);
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody LoginRequest body) {
        String email = body.email() == null ? "" : body.email().trim().toLowerCase(Locale.ROOT);
        UserDto user = auth.login(email, body.password() == null ? "" : body.password());
        return Map.of("token", tokens.issue(user), "user", user);
    }
}
