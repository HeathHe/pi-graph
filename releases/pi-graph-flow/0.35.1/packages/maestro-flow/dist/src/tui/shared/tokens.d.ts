/** Semantic color palette — terminal ANSI names */
export declare const C: {
    /** Primary action/highlight — headers, active selections, focus */
    readonly primary: "cyan";
    /** Completion, selection, enabled states */
    readonly success: "green";
    /** Double-emphasis: selected + highlighted only */
    readonly successBright: "greenBright";
    /** Attention without urgency — warnings, current-state markers */
    readonly warning: "yellow";
    /** Error, failure, disabled status */
    readonly error: "red";
    /** Inactive, secondary, index numbers */
    readonly neutral: "gray";
    /** Metadata accents — model names, effort indicators */
    readonly accent: "magenta";
};
/** Standardized UI symbols */
export declare const SYM: {
    readonly checkOn: "✓";
    readonly checkOff: "·";
    readonly radioOn: "●";
    readonly radioOff: "○";
    readonly cursor: "▶";
    readonly cursorBlank: " ";
    readonly stepDone: "✓";
    readonly stepActive: "▸";
    readonly stepPending: "·";
    readonly enabled: "✓";
    readonly disabled: "✗";
    readonly scrollUp: "▲";
    readonly scrollDown: "▼";
    readonly treeBranch: "├──";
    readonly treeEnd: "└──";
    readonly treePipe: "│";
    readonly dot: "●";
    readonly dotEmpty: "○";
};
/** Spacing constants (Ink Box units) */
export declare const SP: {
    /** Standard label column width for padEnd alignment */
    readonly labelWidth: 14;
    /** Primary panel horizontal padding */
    readonly panelPadX: 2;
    /** Primary panel vertical padding */
    readonly panelPadY: 1;
    /** Detail/secondary panel horizontal padding */
    readonly detailPadX: 1;
    /** Vertical gap between sections (marginTop) */
    readonly sectionGap: 1;
    /** Gap between tabs */
    readonly tabGap: 2;
    /** Gap between inline elements */
    readonly inlineGap: 1;
};
/** Border style presets */
export declare const BORDER: {
    /** Primary containers — round border in cyan */
    readonly primary: {
        readonly borderStyle: "round";
        readonly borderColor: "cyan";
    };
    /** Success containers — round border in green */
    readonly success: {
        readonly borderStyle: "round";
        readonly borderColor: "green";
    };
    /** Warning containers — round border in yellow */
    readonly warning: {
        readonly borderStyle: "round";
        readonly borderColor: "yellow";
    };
    /** Detail/secondary containers — single border in gray */
    readonly detail: {
        readonly borderStyle: "single";
        readonly borderColor: "gray";
    };
};
//# sourceMappingURL=tokens.d.ts.map