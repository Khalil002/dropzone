package dev.dropzone.auth;

import dev.dropzone.config.AppProperties;
import dev.dropzone.web.ApiException;
import dev.dropzone.web.ErrorCode;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
    private final JdbcClient db;
    private final AppProperties props;
    private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder(10);

    public AuthService(JdbcClient db, AppProperties props) {
        this.db = db;
        this.props = props;
    }

    /** Creates the user, their wallet and a balanced signup-credit ledger transaction. */
    @Transactional
    public UserDto register(String email, String password) {
        UserDto user;
        try {
            user = db.sql("INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, role")
                    .params(email, bcrypt.encode(password))
                    .query((rs, i) -> new UserDto(rs.getObject("id", UUID.class), rs.getString("email"), rs.getString("role")))
                    .single();
        } catch (DuplicateKeyException e) {
            throw new ApiException(409, ErrorCode.EMAIL_TAKEN, "Email is already registered");
        }
        UUID accountId = db.sql("INSERT INTO accounts (user_id, kind) VALUES (?, 'customer') RETURNING id")
                .param(user.id()).query(UUID.class).single();
        long credit = props.signupCreditCents();
        UUID txId = db.sql("INSERT INTO ledger_transactions (kind, reference_id) VALUES ('signup_bonus', ?) RETURNING id")
                .param(user.id()).query(UUID.class).single();
        db.sql("INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES (?, ?, ?), (?, ?, ?)")
                .params(txId, AppProperties.PROMO_ACCOUNT_ID, -credit, txId, accountId, credit).update();
        db.sql("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?")
                .params(credit, AppProperties.PROMO_ACCOUNT_ID).update();
        db.sql("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").params(credit, accountId).update();
        return user;
    }

    public UserDto login(String email, String password) {
        record Found(UserDto user, String hash) {}
        Optional<Found> found = db.sql("SELECT id, email, role, password_hash FROM users WHERE lower(email) = ?")
                .param(email)
                .query((rs, i) -> new Found(
                        new UserDto(rs.getObject("id", UUID.class), rs.getString("email"), rs.getString("role")),
                        rs.getString("password_hash")))
                .optional();
        if (found.isEmpty() || !bcrypt.matches(password, found.get().hash())) {
            throw new ApiException(401, ErrorCode.INVALID_CREDENTIALS, "Email or password is incorrect");
        }
        return found.get().user();
    }
}
