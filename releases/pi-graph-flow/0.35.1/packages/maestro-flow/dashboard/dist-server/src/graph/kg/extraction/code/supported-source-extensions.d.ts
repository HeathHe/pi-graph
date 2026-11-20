import type { Language } from '../../db/types.js';
/**
 * Scanner and hook source suffixes have one owner. Keep every extension here so
 * automatic sync cannot silently lag behind language registration.
 */
export declare const SOURCE_EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>>;
export declare const SUPPORTED_SOURCE_EXTENSIONS: ReadonlySet<string>;
/** Returns the final lower-cased suffix, including its leading dot. */
export declare function sourceExtension(filePath: string): string;
export declare function isSupportedSourcePath(filePath: string): boolean;
