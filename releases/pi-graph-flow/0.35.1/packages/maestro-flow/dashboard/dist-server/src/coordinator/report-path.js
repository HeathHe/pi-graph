import { createHash } from 'node:crypto';
import { join } from 'node:path';
const PORTABLE_PATH_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function portableFileStem(value, prefix) {
    if (PORTABLE_PATH_STEM_RE.test(value) && !WINDOWS_RESERVED_BASENAME_RE.test(value)) {
        return value;
    }
    const digest = createHash('sha256').update(value, 'utf8').digest('hex');
    return `${prefix}-${digest}`;
}
export function reportFileStem(nodeId) {
    return portableFileStem(nodeId, 'node');
}
export function resolveCoordinatorReportPath(sessionDir, sessionId, nodeId) {
    return join(sessionDir, portableFileStem(sessionId, 'session'), 'reports', `${reportFileStem(nodeId)}.json`);
}
//# sourceMappingURL=report-path.js.map