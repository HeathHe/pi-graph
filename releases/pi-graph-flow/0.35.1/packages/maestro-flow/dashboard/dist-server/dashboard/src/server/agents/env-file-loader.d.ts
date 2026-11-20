/**
 * Load environment variables from a .env file path.
 * Supports ~ for home directory and relative paths.
 * Returns empty object if file not found or parse fails.
 */
export declare function loadEnvFile(envFilePath: string): Record<string, string>;
