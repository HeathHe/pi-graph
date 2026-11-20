declare const TABS: readonly ["Skills", "Delegate", "Hooks", "Overlay", "Specs", "Analytics", "Install"];
type Tab = (typeof TABS)[number];
export interface ConfigHubProps {
    workDir: string;
    initialTab?: Tab;
    /** Pass-through: jump directly into a skills sub-view */
    skillsInitialView?: 'dashboard' | 'skills' | 'editor' | 'sources';
    editSkill?: string;
    /** Pass-through: jump directly into a delegate sub-view */
    delegateInitialView?: 'dashboard' | 'tools' | 'roles' | 'register' | 'reference' | 'sources';
}
export declare function ConfigHub({ workDir, initialTab, skillsInitialView, editSkill, delegateInitialView, }: ConfigHubProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ConfigHub.d.ts.map