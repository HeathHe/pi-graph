// ---------------------------------------------------------------------------
// Graph Coordinator — Output Parser
// Extracts structured data from agent raw output text.
// ---------------------------------------------------------------------------
const RESULT_MARKER = '--- COORDINATE RESULT ---';
const COMPLETION_MARKER = '--- COMPLETION STATUS ---';
const COMPLETION_END = '--- END STATUS ---';
const FIELD_PATTERNS = {
    status: /^STATUS:\s*(.+)/i,
    phase: /^PHASE:\s*(.+)/i,
    verification_status: /^VERIFICATION_STATUS:\s*(.+)/i,
    review_verdict: /^REVIEW_VERDICT:\s*(.+)/i,
    uat_status: /^UAT_STATUS:\s*(.+)/i,
    artifacts: /^ARTIFACTS:\s*(.+)/i,
    summary: /^SUMMARY:\s*(.+)/i,
};
function makeFailureResult(summary) {
    return {
        structured: {
            status: 'FAILURE',
            phase: null,
            verification_status: null,
            review_verdict: null,
            uat_status: null,
            artifacts: [],
            summary,
        },
    };
}
function parseResultBlock(block) {
    const lines = block.split('\n');
    const raw = {};
    for (const line of lines) {
        const trimmed = line.trim();
        for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
            const m = trimmed.match(pattern);
            if (m) {
                raw[field] = m[1].trim();
            }
        }
    }
    const status = raw.status?.toUpperCase() === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
    const phaseRaw = raw.phase;
    const phase = phaseRaw && phaseRaw.toLowerCase() !== 'none' ? phaseRaw : null;
    const verificationStatus = raw.verification_status || null;
    const reviewVerdict = raw.review_verdict || null;
    const uatStatus = raw.uat_status || null;
    const artifactsRaw = raw.artifacts;
    let artifacts = [];
    if (artifactsRaw && artifactsRaw.toLowerCase() !== 'none') {
        artifacts = artifactsRaw.split(',').map(s => s.trim()).filter(Boolean);
    }
    const summary = raw.summary || '';
    return {
        status,
        phase,
        verification_status: verificationStatus,
        review_verdict: reviewVerdict,
        uat_status: uatStatus,
        artifacts,
        summary,
    };
}
function applyExtractRules(rawOutput, extract, structured) {
    for (const rule of Object.values(extract)) {
        switch (rule.strategy) {
            case 'regex': {
                const m = rawOutput.match(new RegExp(rule.pattern));
                if (m && m[1] !== undefined) {
                    structured[rule.target] = m[1];
                }
                break;
            }
            case 'line_match': {
                for (const line of rawOutput.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith(rule.pattern)) {
                        structured[rule.target] = trimmed.slice(rule.pattern.length).trim();
                        break;
                    }
                }
                break;
            }
            case 'json_path':
                // Reserved for future implementation
                break;
        }
    }
}
/**
 * Parse the optional COMPLETION STATUS block from command output.
 * Enriches structured result with completion_status field.
 */
function parseCompletionStatus(rawOutput, structured) {
    const compIdx = rawOutput.lastIndexOf(COMPLETION_MARKER);
    if (compIdx === -1)
        return;
    const compEnd = rawOutput.indexOf(COMPLETION_END, compIdx);
    const compBlock = rawOutput.slice(compIdx + COMPLETION_MARKER.length, compEnd > compIdx ? compEnd : undefined);
    const statusMatch = compBlock.match(/^STATUS:\s*(.+)/im);
    if (statusMatch) {
        structured.completion_status = statusMatch[1].trim();
    }
    const concernsMatch = compBlock.match(/^CONCERNS:\s*(.+)/im);
    if (concernsMatch) {
        structured.completion_concerns = concernsMatch[1].trim();
    }
    const nextMatch = compBlock.match(/^NEXT:\s*(.+)/im);
    if (nextMatch) {
        structured.completion_next = nextMatch[1].trim();
    }
}
export class DefaultOutputParser {
    parse(rawOutput, node) {
        if (!rawOutput || rawOutput.trim() === '') {
            return makeFailureResult('Empty output');
        }
        // Find the LAST COORDINATE RESULT block
        const lastIdx = rawOutput.lastIndexOf(RESULT_MARKER);
        if (lastIdx !== -1) {
            const blockText = rawOutput.slice(lastIdx + RESULT_MARKER.length);
            const structured = parseResultBlock(blockText);
            // Enrich with completion status if present
            parseCompletionStatus(rawOutput, structured);
            if (node.extract) {
                applyExtractRules(rawOutput, node.extract, structured);
            }
            return { structured };
        }
        // No RESULT block — this is the contract the prompt assembler mandates,
        // so its absence is a protocol failure. Never infer SUCCESS from free-form
        // output: a silent-success fallback hides real failures and breaks decision
        // nodes that branch on verification_status / review_verdict.
        const result = makeFailureResult('No COORDINATE RESULT block found');
        if (node.extract) {
            applyExtractRules(rawOutput, node.extract, result.structured);
        }
        return result;
    }
}
//# sourceMappingURL=output-parser.js.map