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

// A typo like HEARTBEAT_INTERVAL_MS=5s would otherwise become NaN and turn a
// timer into a busy loop — reject it at startup instead.
function getIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`❌ CONFIG ERROR: ${key} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

// 1. Core Config
export const REDIS_URL = getEnv("REDIS_URL"); // Required

// 2. Numerical Config (with sensible defaults)
export const QUEUE_DEFAULT_CONCURRENCY = getIntEnv("QUEUE_DEFAULT_CONCURRENCY", 1);
export const HEARTBEAT_INTERVAL_MS = getIntEnv("HEARTBEAT_INTERVAL_MS", 5000);
export const STALL_THRESHOLD_MS = getIntEnv("STALL_THRESHOLD_MS", 30000);
export const SCHEDULER_POLL_MS = getIntEnv("SCHEDULER_POLL_MS", 500);

/**
 * Summary of config status
 */
export function validateConfig() {
  console.log("✅ Configuration Validated");
}
