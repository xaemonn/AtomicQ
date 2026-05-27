import { v4 as uuidv4 } from "uuid";

/**
 * Generates a unique Job ID.
 * 
 * Strategy: Timestamp-prefixed UUID v4
 * Why:
 * 1. Distributed Safety: Unlike sequential IDs (1, 2, 3), multiple workers can generate
 *    these IDs independently without needing a central coordinator or risking a race condition
 *    where two workers get the same ID.
 * 2. Lexicographical Sortability: By putting Date.now() first, IDs naturally sort by 
 *    creation time in Redis, which is incredibly useful for manual debugging in the CLI. 
 * 3. Low Collision Risk: Appending a UUID v4 ensures that even if two jobs are created 
 *    in the exact same millisecond, the chance of a collision is effectively zero.
 */
export function generateJobId(): string {
  return `${Date.now()}-${uuidv4()}`;
}

/**
 * Optional: Plain UUID v4 generator if sortability isn't required.
 */
export function generatePlainId(): string {
  return uuidv4();
}
