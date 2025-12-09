import Redis from "ioredis";
import dotenv from "dotenv";
import { REDIS_URL } from "./constants";

dotenv.config();

const redisUrl = REDIS_URL;

const defaultOptions = {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: true,
  lazyConnect: false,
};

export const redisPrimary = new Redis(redisUrl, defaultOptions);
export const redisRate = redisPrimary.duplicate();
export const redisPublisher = redisPrimary.duplicate({
  maxRetriesPerRequest: 20,
});

redisPrimary.on("error", (err) => {
  console.error("Redis Primary connection error:", err);
});

redisPrimary.on("connect", () => {
  console.log("Redis Primary connected");
});

redisRate.on("error", (err) => {
  console.error("Redis Rate connection error:", err);
});

redisRate.on("connect", () => {
  console.log("Redis Rate connected");
});

redisPublisher.on("error", (err) => {
  console.error("Redis Publisher connection error:", err);
});

export async function closeRedis() {
  await Promise.all([
    redisPrimary.quit(),
    redisPublisher.quit(),
    redisRate.quit(),
  ]);
}

// process.on("SIGTERM", closeRedis);
// process.on("SIGINT", closeRedis);
