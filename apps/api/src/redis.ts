import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
});

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});