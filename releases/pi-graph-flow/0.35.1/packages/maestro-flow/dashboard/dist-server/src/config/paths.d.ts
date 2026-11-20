export declare const paths: {
    readonly home: string;
    readonly config: string;
    readonly specs: string;
    readonly extensions: string;
    readonly data: string;
    readonly logs: string;
    readonly cliHistory: string;
    readonly skillConfig: string;
    readonly workflows: string;
    readonly prepare: string;
    readonly ref: string;
    readonly archKb: string;
    readonly project: (root: string) => {
        root: string;
        workflow: string;
        templates: string;
        prepare: string;
        ref: string;
    };
    readonly ensure: (...dirs: string[]) => void;
};
