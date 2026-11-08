package dev.dropzone.messaging;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.dropzone.domain.Rules;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Turns order.confirmed events into notifications; event_id makes redelivery harmless. */
@Component
public class NotificationListener {
    private final JdbcClient db;
    private final ObjectMapper mapper;

    public NotificationListener(JdbcClient db, ObjectMapper mapper) {
        this.db = db;
        this.mapper = mapper;
    }

    @RabbitListener(queues = Messaging.NOTIFICATION_QUEUE)
    public void onOrderConfirmed(Message message) throws IOException {
        JsonNode event = mapper.readTree(new String(message.getBody(), StandardCharsets.UTF_8));
        db.sql("INSERT INTO notifications (user_id, event_id, kind, message) VALUES (?, ?, 'order.confirmed', ?) "
                        + "ON CONFLICT (event_id) DO NOTHING")
                .params(UUID.fromString(event.get("userId").asText()), UUID.fromString(event.get("eventId").asText()),
                        Rules.notificationMessage(event.get("quantity").asInt(), event.get("dropName").asText()))
                .update();
    }
}
