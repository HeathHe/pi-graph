import type { UnifiedEdge } from '../db/types.js';
export interface SynthesisResult {
    edges: UnifiedEdge[];
    channelsFound: number;
    callbacksLinked: number;
    durationMs: number;
}
export interface CallbackQueryAdapter {
    getNodesByKind(kind: string): Array<{
        id: string;
        name: string;
        qualifiedName: string;
        filePath: string;
    }>;
    getOutgoingEdges(nodeId: string, kind?: string): Array<{
        target: string;
        kind: string;
        line?: number;
    }>;
    getIncomingEdges(nodeId: string, kind?: string): Array<{
        source: string;
        kind: string;
        line?: number;
    }>;
    insertEdges(edges: UnifiedEdge[]): number;
}
/**
 * 运行全部 14 个阶段的回调合成
 *
 * Phase 1-5 为通用阶段 (已实现)
 * Phase 6-11 为框架特化阶段 (Vue SFC, Go gRPC, React Native, Fabric, MyBatis, Gin)
 *   — 完整版从 CodeGraph callback-synthesizer.ts 移植
 *
 * 扇出上限保护:
 *   MAX_CALLBACKS_PER_CHANNEL = 40
 *   EVENT_FANOUT_CAP = 6
 *   CC_FANOUT_CAP = 8
 *   MAX_JSX_CHILDREN = 30
 */
export declare function runCallbackSynthesis(adapter: CallbackQueryAdapter): SynthesisResult;
//# sourceMappingURL=callback-synthesizer.d.ts.map