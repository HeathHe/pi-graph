/**
 * Read and parse a JSON file with retry logic.
 *
 * - Returns `null` when the file does not exist (ENOENT).
 * - Retries up to 3 times with 100ms delay on JSON parse errors,
 *   which can occur when another process is mid-write.
 * - Throws after max retries on persistent parse failure.
 */
export declare function readJsonSafe<T>(filePath: string): Promise<T | null>;
