import amqp from "amqplib";
import { config } from "../config.js";
import { pool } from "../db.js";
import { notificationMessage } from "../domain/rules.js";

export const EXCHANGE = "dropzone.events";
export const NOTIFICATION_QUEUE = "dropzone.notifications";

let channel: amqp.ConfirmChannel | undefined;

export async function connectRabbit(): Promise<amqp.ConfirmChannel> {
  const { host, port, user, password } = config.rabbit;
  const connection = await amqp.connect({ hostname: host, port, username: user, password });
  connection.on("close", () => { channel = undefined; });
  connection.on("error", () => { channel = undefined; });
  const ch = await connection.createConfirmChannel();
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  await ch.assertQueue(NOTIFICATION_QUEUE, { durable: true });
  await ch.bindQueue(NOTIFICATION_QUEUE, EXCHANGE, "order.confirmed");
  await ch.prefetch(20);
  channel = ch;
  return ch;
}

export const rabbitReady = () => channel !== undefined;

interface OutboxRow { id: number; event_id: string; event_type: string; payload: Record<string, unknown> }

/**
 * Relays committed outbox rows to RabbitMQ. SKIP LOCKED lets many publishers
 * share the table; rows are marked published only after the broker confirms.
 */
export async function publishOutboxTick(): Promise<number> {
  const ch = channel;
  if (!ch) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, event_id, event_type, payload FROM outbox_events
        WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows) {
      const body = Buffer.from(JSON.stringify({ eventId: row.event_id, ...row.payload }));
      ch.publish(EXCHANGE, row.event_type, body, {
        persistent: true, contentType: "application/json", messageId: row.event_id, type: row.event_type,
      });
    }
    if (rows.length) {
      await ch.waitForConfirms();
      await client.query("UPDATE outbox_events SET published_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Turns order.confirmed events into notifications; event_id makes redelivery harmless. */
export async function handleOrderConfirmed(event: {
  eventId: string; userId: string; dropName: string; quantity: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (user_id, event_id, kind, message) VALUES ($1, $2, 'order.confirmed', $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [event.userId, event.eventId, notificationMessage(event.quantity, event.dropName)],
  );
}

export async function startConsumer(ch: amqp.ConfirmChannel): Promise<void> {
  await ch.consume(NOTIFICATION_QUEUE, async (msg) => {
    if (!msg) return;
    try {
      await handleOrderConfirmed(JSON.parse(msg.content.toString()));
      ch.ack(msg);
    } catch (err) {
      console.error("notification consumer failed", err);
      ch.nack(msg, false, !msg.fields.redelivered); // retry once, then drop
    }
  });
}
