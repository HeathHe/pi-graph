// ---------------------------------------------------------------------------
// detect.ts — detect system locale for i18n
// ---------------------------------------------------------------------------
import { execSync } from 'node:child_process';
function isChinese(s) {
    return s.toLowerCase().startsWith('zh');
}
function detectMacOSLanguage() {
    if (process.platform !== 'darwin')
        return null;
    try {
        const raw = execSync('defaults read -g AppleLanguages', {
            encoding: 'utf-8',
            timeout: 500,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const first = raw.match(/"([^"]+)"/)?.[1];
        if (first && isChinese(first))
            return 'zh';
    }
    catch {
        // defaults command failed — fall through
    }
    return null;
}
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
export function detectLocale() {
    // 1. Explicit override
    const env = process.env.MAESTRO_LOCALE;
    if (env) {
        return isChinese(env.trim()) ? 'zh' : 'en';
    }
    // 2. Intl API (works on Windows, macOS, Linux)
    try {
        const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (intlLocale && isChinese(intlLocale))
            return 'zh';
    }
    catch {
        // Intl not available — fall through
    }
    // 3. macOS system preference
    const macLocale = detectMacOSLanguage();
    if (macLocale)
        return macLocale;
    // 4. Unix env vars
    const langEnv = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES;
    if (langEnv && isChinese(langEnv))
        return 'zh';
    return 'en';
}
//# sourceMappingURL=detect.js.map