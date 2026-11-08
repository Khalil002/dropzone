package dev.dropzone.auth;

import dev.dropzone.web.ApiException;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/me")
public class MeController {
    private final JdbcClient db;

    public MeController(JdbcClient db) {
        this.db = db;
    }

    @GetMapping
    public Map<String, Object> me(@AuthenticationPrincipal Jwt jwt) {
        return db.sql("""
                SELECT u.id, u.email, u.role, COALESCE(a.balance_cents, 0) AS balance
                  FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = ?""")
                .param(CurrentUser.id(jwt))
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getObject("id", UUID.class));
                    m.put("email", rs.getString("email"));
                    m.put("role", rs.getString("role"));
                    m.put("balanceCents", rs.getLong("balance"));
                    return m;
                })
                .optional()
                .orElseThrow(() -> ApiException.notFound("User"));
    }

    @GetMapping("/notifications")
    public List<Map<String, Object>> notifications(@AuthenticationPrincipal Jwt jwt) {
        return db.sql("""
                SELECT id, kind, message, created_at FROM notifications
                 WHERE user_id = ? ORDER BY created_at DESC LIMIT 50""")
                .param(CurrentUser.id(jwt))
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getObject("id", UUID.class));
                    m.put("kind", rs.getString("kind"));
                    m.put("message", rs.getString("message"));
                    m.put("createdAt", rs.getTimestamp("created_at").toInstant().truncatedTo(ChronoUnit.MILLIS));
                    return m;
                })
                .list();
    }
}
