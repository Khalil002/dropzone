import { config } from "./config.js";
import { createApp } from "./app.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import { admitTick } from "./jobs/admitter.js";
import { connectRabbit, publishOutboxTick, rabbitReady, startConsumer } from "./jobs/messaging.js";
import { every } from "./jobs/scheduler.js";

let connecting = false;

async function connectRabbitWithRetry(): Promise<void> {
  if (connecting) return;
  connecting = true;
  for (let attempt = 1; ; attempt++) {
    try {
      const ch = await connectRabbit();
      await startConsumer(ch);
      console.log("connected to RabbitMQ");
      connecting = false;
      return;
    } catch (err) {
      const delay = Math.min(10_000, 500 * attempt);
      console.warn(`RabbitMQ unavailable (${(err as Error).message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const server = createApp().listen(config.port, () => {
  console.log(`dropzone express backend listening on :${config.port}`);
});

void connectRabbitWithRetry();
const stops = [
  every("admitter", config.admitIntervalMs, admitTick),
  every("outbox", 500, publishOutboxTick),
  // Reconnect if the broker connection dropped.
  every("rabbit-watchdog", 5000, async () => { if (!rabbitReady()) await connectRabbitWithRetry(); }),
];

const shutdown = () => {
  stops.forEach((stop) => stop());
  server.close(() => {
    void Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
