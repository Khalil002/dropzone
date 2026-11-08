import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis({ host: config.redis.host, port: config.redis.port, maxRetriesPerRequest: 3 });

/** Redis key names shared by all three backends. */
export const keys = {
  dropsCache: "dz:cache:drops",
  queue: (dropId: string) => `dz:queue:${dropId}`,
  queueSeq: (dropId: string) => `dz:queue:${dropId}:seq`,
  admitted: (dropId: string, userId: string) => `dz:admitted:${dropId}:${userId}`,
  rateLimit: (userId: string, window: number) => `dz:rl:${userId}:${window}`,
};
