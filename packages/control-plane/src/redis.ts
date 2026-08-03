import { Redis } from "@upstash/redis";
import { loadConfig } from "@daybreak/shared";

let redis: Redis | undefined;

export function getRedis(): Redis {
  if (redis) return redis;
  const config = loadConfig();
  const url = config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL;
  const token = config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_TOKEN are required");
  }
  redis = new Redis({ url, token });
  return redis;
}
