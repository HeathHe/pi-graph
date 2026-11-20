// ---------------------------------------------------------------------------
// index.ts — i18n entry point
//
// Usage:
//   import { t } from '../../i18n/index.js';
//   <Text>{t.install.modeTitle}</Text>
// ---------------------------------------------------------------------------
import { detectLocale } from './detect.js';
import { en } from './locales/en.js';
import { zh } from './locales/zh.js';
const locales = { en, zh };
/** Current locale strings — detected from system language. */
export const t = locales[detectLocale()];
//# sourceMappingURL=index.js.map