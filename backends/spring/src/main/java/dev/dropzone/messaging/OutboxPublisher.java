package dev.dropzone.messaging;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Relays committed outbox rows to RabbitMQ. SKIP LOCKED lets several instances share the
 * table, and rows are marked published only after the broker confirms them.
 */
@Component
public class OutboxPublisher {
    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);
    private final JdbcClient db;
    private final RabbitTemplate rabbit;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;

    public OutboxPublisher(JdbcClient db, RabbitTemplate rabbit, ObjectMapper mapper, TransactionTemplate tx) {
        this.db = db;
        this.rabbit = rabbit;
        this.mapper = mapper;
        this.tx = tx;
    }

    record Row(long id, UUID eventId, String type, String payload) {}

    @Scheduled(fixedDelay = 500)
    public void publish() {
        try {
            tx.executeWithoutResult(status -> {
                List<Row> rows = db.sql("SELECT id, event_id, event_type, payload::text AS payload FROM outbox_events "
                                + "WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED")
                        .query((rs, i) -> new Row(rs.getLong("id"), rs.getObject("event_id", UUID.class),
                                rs.getString("event_type"), rs.getString("payload")))
                        .list();
                if (rows.isEmpty()) return;
                rabbit.invoke(ops -> {
                    for (Row row : rows) ops.send(Messaging.EXCHANGE, row.type(), toMessage(row));
                    ops.waitForConfirmsOrDie(5_000);
                    return null;
                });
                db.sql("UPDATE outbox_events SET published_at = now() WHERE id = ANY(?)")
                        .param(rows.stream().map(Row::id).toArray(Long[]::new)).update();
            });
        } catch (Exception e) {
            log.warn("outbox publish failed: {}", e.getMessage());
        }
    }

    private Message toMessage(Row row) {
        try {
            ObjectNode body = (ObjectNode) mapper.readTree(row.payload());
            ObjectNode withId = mapper.createObjectNode().put("eventId", row.eventId().toString());
            withId.setAll(body);
            MessageProperties props = new MessageProperties();
            props.setContentType(MessageProperties.CONTENT_TYPE_JSON);
            props.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
            props.setMessageId(row.eventId().toString());
            props.setType(row.type());
            return new Message(mapper.writeValueAsString(withId).getBytes(StandardCharsets.UTF_8), props);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
