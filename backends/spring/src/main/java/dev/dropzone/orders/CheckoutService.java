package dev.dropzone.orders;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.dropzone.config.AppProperties;
import dev.dropzone.domain.Rules;
import dev.dropzone.web.ApiException;
import dev.dropzone.web.ErrorCode;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CheckoutService {
    private final JdbcClient db;
    private final ObjectMapper mapper;

    public CheckoutService(JdbcClient db, ObjectMapper mapper) {
        this.db = db;
        this.mapper = mapper;
    }

    public record StoredResponse(String requestHash, int status, String body) {}

    /** Either a fresh order body, or the response a concurrent request with the same key stored first. */
    public record Outcome(String body, StoredResponse raced) {}

    public Optional<StoredResponse> stored(UUID userId, String key) {
        return db.sql("SELECT request_hash, response_status, response_body::text AS body FROM idempotency_keys "
                        + "WHERE user_id = ? AND key = ?")
                .params(userId, key)
                .query((rs, i) -> new StoredResponse(rs.getString("request_hash"), rs.getInt("response_status"),
                        rs.getString("body")))
                .optional();
    }

    /**
     * One database transaction: conditional stock decrement, wallet debit under a row lock,
     * balanced ledger legs, the order, an outbox event and the stored idempotent response.
     * Any ApiException rolls the whole thing back.
     */
    @Transactional
    public Outcome checkout(UUID userId, String key, String requestHash, UUID dropId, int quantity) {
        // Serialise concurrent requests sharing a key, then re-check for a stored response.
        db.sql("SELECT pg_advisory_xact_lock(hashtext(? || ':' || ?))").params(userId.toString(), key)
                .query((rs, i) -> 1).single();
        Optional<StoredResponse> raced = stored(userId, key);
        if (raced.isPresent()) return new Outcome(null, raced.get());

        boolean dup = db.sql("SELECT 1 FROM orders WHERE user_id = ? AND drop_id = ?").params(userId, dropId)
                .query(Integer.class).optional().isPresent();
        if (dup) throw alreadyOrdered();

        // Conditional decrement: never oversells, even under heavy concurrency.
        record Stock(long price, String name) {}
        Stock stock = db.sql("UPDATE drops SET remaining_stock = remaining_stock - ? "
                        + "WHERE id = ? AND remaining_stock >= ? RETURNING price_cents, name")
                .params(quantity, dropId, quantity)
                .query((rs, i) -> new Stock(rs.getLong("price_cents"), rs.getString("name")))
                .optional()
                .orElseThrow(() -> new ApiException(409, ErrorCode.SOLD_OUT, "Not enough stock left"));
        long total = Rules.orderTotal(stock.price(), quantity);

        // Lock the wallet row so concurrent purchases cannot both spend the same balance.
        record Wallet(UUID id, long balance) {}
        Wallet wallet = db.sql("SELECT id, balance_cents FROM accounts WHERE user_id = ? FOR UPDATE").param(userId)
                .query((rs, i) -> new Wallet(rs.getObject("id", UUID.class), rs.getLong("balance_cents")))
                .optional()
                .filter(w -> w.balance() >= total)
                .orElseThrow(() -> new ApiException(402, ErrorCode.INSUFFICIENT_FUNDS, "Wallet balance is too low"));

        Order order;
        try {
            order = db.sql("INSERT INTO orders (user_id, drop_id, quantity, total_cents) VALUES (?, ?, ?, ?) "
                            + "RETURNING id, drop_id, quantity, total_cents, status, created_at")
                    .params(userId, dropId, quantity, total)
                    .query((rs, i) -> new Order(rs.getObject("id", UUID.class), rs.getObject("drop_id", UUID.class),
                            rs.getInt("quantity"), rs.getLong("total_cents"), rs.getString("status"),
                            rs.getTimestamp("created_at").toInstant().truncatedTo(ChronoUnit.MILLIS)))
                    .single();
        } catch (DuplicateKeyException e) {
            throw alreadyOrdered();
        }

        UUID txId = db.sql("INSERT INTO ledger_transactions (kind, reference_id) VALUES ('purchase', ?) RETURNING id")
                .param(order.id()).query(UUID.class).single();
        db.sql("INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES (?, ?, ?), (?, ?, ?)")
                .params(txId, wallet.id(), -total, txId, AppProperties.REVENUE_ACCOUNT_ID, total).update();
        db.sql("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").params(total, wallet.id()).update();
        db.sql("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?")
                .params(total, AppProperties.REVENUE_ACCOUNT_ID).update();

        Map<String, Object> event = new LinkedHashMap<>();
        event.put("orderId", order.id());
        event.put("userId", userId);
        event.put("dropId", dropId);
        event.put("dropName", stock.name());
        event.put("quantity", quantity);
        event.put("totalCents", total);
        db.sql("INSERT INTO outbox_events (event_type, payload) VALUES ('order.confirmed', ?::jsonb)")
                .param(json(event)).update();

        String body = json(order);
        db.sql("INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body) "
                        + "VALUES (?, ?, ?, 201, ?::jsonb)")
                .params(userId, key, requestHash, body).update();
        return new Outcome(body, null);
    }

    private static ApiException alreadyOrdered() {
        return new ApiException(409, ErrorCode.ALREADY_ORDERED, "You already bought this drop");
    }

    private String json(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
