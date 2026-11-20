// src/graph/kg/extraction/code/dfm-extractor.ts
// Delphi DFM/FMX 窗体提取器:
// 组件层级 → contains edge
// OnClick 等事件 → calls edge
// 参考: codegraph/src/extraction/dfm-extractor.ts
function parseDfm(source) {
    const components = [];
    const lines = source.split('\n');
    let current = null;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNum = i + 1;
        // object Name: Type
        const objMatch = line.match(/^object\s+(\w+)\s*:\s*(\w+)/i);
        if (objMatch) {
            depth++;
            const parentName = current != null ? current.name : null;
            const newComponent = {
                type: objMatch[2],
                name: objMatch[1],
                parentName,
                startLine: lineNum,
                endLine: lineNum,
                properties: {},
                events: [],
            };
            components.push(newComponent);
            current = newComponent;
            continue;
        }
        // end — 关闭当前组件
        if (/^end\b/i.test(line)) {
            if (current) {
                current.endLine = lineNum;
                // 回到父组件
                const parentName = current.parentName;
                current = components.findLast(c => c.name === parentName) ?? null;
            }
            depth--;
            continue;
        }
        // 属性赋值
        if (current && line.includes('=')) {
            const eqIdx = line.indexOf('=');
            const key = line.substring(0, eqIdx).trim();
            const value = line.substring(eqIdx + 1).trim();
            // 事件: OnXxx = HandlerName
            if (key.startsWith('On')) {
                current.events.push({
                    event: key,
                    handler: value,
                    line: lineNum,
                });
            }
            else {
                current.properties[key] = value;
            }
        }
    }
    return components;
}
export function extractDfm(source, filePath) {
    const symbols = [];
    const references = [];
    const edges = [];
    const components = parseDfm(source);
    for (const comp of components) {
        const qualifiedName = comp.parentName
            ? `${comp.parentName}.${comp.name}`
            : comp.name;
        // 组件 → struct/type_alias node
        symbols.push({
            kind: 'component',
            name: comp.name,
            qualifiedName,
            filePath,
            language: 'pascal',
            startLine: comp.startLine,
            endLine: comp.endLine,
            startColumn: 1,
            endColumn: 1,
            docstring: '',
            signature: `object ${comp.name}: ${comp.type}`,
            visibility: 'public',
            isExported: false,
            isAsync: false,
            isStatic: false,
            isAbstract: false,
            decorators: [],
            typeParameters: [],
        });
        // contains edge: parent → child
        if (comp.parentName) {
            const parentQn = components.find(c => c.name === comp.parentName)
                ? (components.find(c => c.name === comp.parentName).parentName
                    ? `${components.find(c => c.name === comp.parentName).parentName}.${comp.parentName}`
                    : comp.parentName)
                : comp.parentName;
            edges.push({
                source: `code:${filePath}:${parentQn}`,
                target: `code:${filePath}:${qualifiedName}`,
                kind: 'contains',
            });
        }
        // 事件 → calls edge
        for (const evt of comp.events) {
            references.push({
                fromSymbolName: qualifiedName,
                fromSymbolId: `code:${filePath}:${qualifiedName}`,
                referenceName: evt.handler,
                referenceKind: 'calls',
                line: evt.line,
                col: 1,
                filePath,
                language: 'pascal',
            });
        }
    }
    return { symbols, references, structuralReferences: [], edges };
}
//# sourceMappingURL=dfm-extractor.js.map