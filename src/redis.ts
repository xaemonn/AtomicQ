import Redis from "ioredis";
import { REDIS_URL } from "./config";

/**
 * Singleton Redis connection used across the application.
 * Uses REDIS_URL from environmental configuration.
 */
const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    if (times > 10) {
      console.error("Redis: Max retries reached. Shutting down.");
      return null; // stop retrying
    }
    console.log(`Redis: Reconnecting... (Attempt ${times})`);
    return 500; // wait 500ms
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
