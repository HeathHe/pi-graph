export type ConfigInitialView = 'dashboard' | 'skills' | 'editor' | 'sources';
export type DelegateInitialView = 'dashboard' | 'tools' | 'roles' | 'register' | 'reference' | 'sources';
export type ConfigHubTab = 'Skills' | 'Delegate' | 'Hooks' | 'Overlay' | 'Specs' | 'Analytics' | 'Install';
/** Unified config hub — tab-based switcher between all config panels. */
export declare function runConfigHub(options?: {
    initialTab?: ConfigHubTab;
    skillsInitialView?: ConfigInitialView;
    editSkill?: string;
    delegateInitialView?: DelegateInitialView;
}): Promise<void>;
/** Skills config TUI — direct entry. */
export declare function runConfigTui(initialView?: ConfigInitialView, editSkill?: string): Promise<void>;
/** Delegate config TUI — direct entry. */
export declare function runDelegateConfigTui(initialView?: DelegateInitialView): Promise<void>;
/** Hooks panel — direct entry. */
export declare function runHooksTui(): Promise<void>;
/** Overlay panel — direct entry. */
export declare function runOverlayTui(): Promise<void>;
/** Specs panel — direct entry. */
export declare function runSpecsTui(): Promise<void>;
/** Analytics panel — direct entry. */
export declare function runSpecAnalyticsTui(): Promise<void>;
/** Install panel — direct entry. */
export declare function runInstallTui(): Promise<void>;
//# sourceMappingURL=index.d.ts.map