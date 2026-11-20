/** Host-owned clock; schedule must defer callbacks and return an idempotent cancel.
 * No physical-compaction settlement or permission authority is implied. */
export interface CompactionClockPort {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
