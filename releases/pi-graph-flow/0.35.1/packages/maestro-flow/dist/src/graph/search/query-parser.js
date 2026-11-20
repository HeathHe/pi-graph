import { NODE_KINDS, LANGUAGES } from '../types.js';
const KIND_VALUES = new Set(NODE_KINDS);
const LANGUAGE_VALUES = new Set(LANGUAGES);
function unquote(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"'))
        return s.slice(1, -1);
    return s;
}
export function parseQuery(raw) {
    const out = {
        text: '',
        kinds: [],
        languages: [],
        pathFilters: [],
        nameFilters: [],
    };
    const tokens = [];
    let i = 0;
    while (i < raw.length) {
        while (i < raw.length && /\s/.test(raw[i]))
            i++;
        if (i >= raw.length)
            break;
        const start = i;
        while (i < raw.length && !/\s/.test(raw[i])) {
            if (raw[i] === '"') {
                const end = raw.indexOf('"', i + 1);
                if (end === -1) {
                    i = raw.length;
                    break;
                }
                i = end + 1;
                continue;
            }
            i++;
        }
        tokens.push(raw.slice(start, i));
    }
    const textParts = [];
    for (const tok of tokens) {
        const colon = tok.indexOf(':');
        if (colon <= 0 || colon === tok.length - 1) {
            textParts.push(tok);
            continue;
        }
        const key = tok.slice(0, colon).toLowerCase();
        const valueRaw = unquote(tok.slice(colon + 1));
        if (!valueRaw) {
            textParts.push(tok);
            continue;
        }
        switch (key) {
            case 'kind':
                if (KIND_VALUES.has(valueRaw))
                    out.kinds.push(valueRaw);
                else
                    textParts.push(tok);
                break;
            case 'lang':
            case 'language': {
                const lower = valueRaw.toLowerCase();
                if (LANGUAGE_VALUES.has(lower))
                    out.languages.push(lower);
                else
                    textParts.push(tok);
                break;
            }
            case 'path':
                out.pathFilters.push(valueRaw);
                break;
            case 'name':
                out.nameFilters.push(valueRaw);
                break;
            default:
                textParts.push(tok);
        }
    }
    out.text = textParts.join(' ').trim();
    return out;
}
export function boundedEditDistance(a, b, maxDist) {
    if (a === b)
        return 0;
    const al = a.length;
    const bl = b.length;
    if (Math.abs(al - bl) > maxDist)
        return maxDist + 1;
    if (al === 0)
        return bl;
    if (bl === 0)
        return al;
    let prev = new Array(bl + 1);
    let cur = new Array(bl + 1);
    for (let j = 0; j <= bl; j++)
        prev[j] = j;
    for (let i = 1; i <= al; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= bl; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            if (cur[j] < rowMin)
                rowMin = cur[j];
        }
        if (rowMin > maxDist)
            return maxDist + 1;
        [prev, cur] = [cur, prev];
    }
    return prev[bl];
}
//# sourceMappingURL=query-parser.js.map