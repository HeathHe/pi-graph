// ---------------------------------------------------------------------------
// PromptGuard — Detects prompt injection patterns
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'instruction-override' },
    { pattern: /you\s+are\s+now\s+/i, label: 'role-confusion' },
    { pattern: /^system:/mi, label: 'system-prompt-injection' },
    { pattern: /forget\s+(everything|all|your)\s/i, label: 'memory-wipe' },
    { pattern: /pretend\s+(you\s+are|to\s+be)/i, label: 'role-impersonation' },
    { pattern: /do\s+not\s+follow\s+(any|your)\s/i, label: 'instruction-bypass' },
    { pattern: /override\s+(your|the)\s+(instructions|rules|guidelines)/i, label: 'rule-override' },
    { pattern: /\bbase64\s*[:=]\s*[A-Za-z0-9+/]{20,}/i, label: 'encoded-command' },
    { pattern: /\]\s*\(\s*data:/i, label: 'data-uri-injection' },
    { pattern: /new\s+instructions?\s*:/i, label: 'new-instruction' },
    { pattern: /disregard\s+(the\s+)?(above|previous)/i, label: 'disregard' },
    { pattern: /act\s+as\s+(if|though)\s+you/i, label: 'behavior-override' },
    { pattern: /translate\s+.*\bto\s+(shell|bash|python|javascript)\b/i, label: 'code-execution-via-translate' },
];
/**
 * Pure evaluation function — portable, no I/O dependencies.
 * @param prompt The user prompt text to scan
 */
export function evaluatePromptGuard(prompt) {
    const detected = [];
    for (const { pattern, label } of INJECTION_PATTERNS) {
        if (pattern.test(prompt)) {
            detected.push(label);
        }
    }
    if (detected.length > 0) {
        return {
            flagged: true,
            labels: detected,
            warning: `[PromptGuard] WARNING: Potential prompt injection detected (${detected.join(', ')}). Proceeding with caution.`,
        };
    }
    return { flagged: false, labels: [] };
}
/** In-process plugin for coordinator graph-walker */
export class PromptGuard {
    name = 'promptGuard';
    apply(registry) {
        registry.transformPrompt.tap(this.name, (promptText) => {
            const result = evaluatePromptGuard(promptText);
            if (result.flagged) {
                return `\n${result.warning}\n` + promptText;
            }
            return promptText;
        });
    }
}
//# sourceMappingURL=prompt-guard.js.map