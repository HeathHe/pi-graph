export type Locale = 'en' | 'zh';
/**
 * Detect the user's preferred locale.
 *
 * Priority:
 *   1. MAESTRO_LOCALE env var (explicit override)
 *   2. Intl.DateTimeFormat().resolvedOptions().locale (cross-platform)
 *   3. macOS: `defaults read -g AppleLanguages` (system preference)
 *   4. LANG / LC_ALL / LC_MESSAGES env vars (Unix fallback)
 *
 * Returns 'zh' for any Chinese variant (zh-CN, zh-TW, zh-HK, etc.), else 'en'.
 */
export declare function detectLocale(): Locale;
//# sourceMappingURL=detect.d.ts.map