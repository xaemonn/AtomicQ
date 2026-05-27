import "dotenv/config";

/**
 * Validates and exports environment configuration.
 * Fails fast with a clear error if required variables are missing.
 */

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`❌ CONFIG ERROR: Missing required environment variable: ${key}`);
  }
  return value || (defaultValue as string);
}

// 1. Core Config
export const REDIS_URL = getEnv("REDIS_URL"); // Required

// 2. Numerical Config (with sensible defaults)
export const QUEUE_DEFAULT_CONCURRENCY = parseInt(getEnv("QUEUE_DEFAULT_CONCURRENCY", "1"), 10);
export const HEARTBEAT_INTERVAL_MS = parseInt(getEnv("HEARTBEAT_INTERVAL_MS", "5000"), 10);
export const STALL_THRESHOLD_MS = parseInt(getEnv("STALL_THRESHOLD_MS", "30000"), 10);
export const SCHEDULER_POLL_MS = parseInt(getEnv("SCHEDULER_POLL_MS", "500"), 10);

/**
 * Summary of config status
 */
export function validateConfig() {
  console.log("✅ Configuration Validated");
}
