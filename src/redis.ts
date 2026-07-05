import Redis from "ioredis";
import { REDIS_URL } from "./config";

/**
 * Singleton Redis connection used across the application.
 * Uses REDIS_URL from environmental configuration.
 */
const redis = new Redis(REDIS_URL, {
  // Never give up: a process that stops reconnecting stays broken after Redis
  // comes back. Wait a little longer each time, up to one attempt every 5s.
  retryStrategy(times) {
    console.log(`Redis: Reconnecting... (Attempt ${times})`);
    return Math.min(times * 500, 5000);
  },
});

redis.on("connect", () => {
  console.log("Redis: Connected successfully.");
});

redis.on("error", (err) => {
  console.error("Redis: Connection Error", err);
});

redis.on("reconnecting", () => {
  console.log("Redis: Reconnecting...");
});

export default redis;
