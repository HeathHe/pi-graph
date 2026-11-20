import { sep, posix } from 'node:path';
/** Convert OS-specific path separators to forward slashes */
export function toForwardSlash(p) {
    return p.split(sep).join(posix.sep);
}
//# sourceMappingURL=utils.js.map