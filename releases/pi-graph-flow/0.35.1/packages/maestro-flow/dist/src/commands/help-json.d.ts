import { Command } from 'commander';
export interface HelpCatalogOption {
    names: string[];
    required: boolean;
    value_arity: 0 | 1 | -1;
    repeatable: boolean;
    choices: string[];
    value_constraint?: 'portable-path-segment' | null;
}
export interface HelpCatalogPositional {
    name: string;
    required: boolean;
    variadic: boolean;
    choices: string[];
}
export interface HelpCatalogCommand {
    command: string;
    description: string;
    mutation_scope: 'read' | 'run' | 'orchestration' | 'artifact' | 'retired';
    cas_target: 'none' | 'run' | 'orchestration' | 'artifact';
    options: string[];
    option_specs: HelpCatalogOption[];
    positionals: HelpCatalogPositional[];
    examples: string[];
    deprecated: boolean;
    replacement: string | null;
}
export interface HelpCatalogValidationError {
    code: 'UNKNOWN_OPTION' | 'MISSING_VALUE' | 'INVALID_VALUE' | 'EXCESS_POSITIONAL' | 'MISSING_REQUIRED' | 'UNKNOWN_COMMAND';
    argument: string;
    commandPath: string;
    suggestion?: string;
}
export interface HelpCatalogValidationResult {
    ok: boolean;
    errors: HelpCatalogValidationError[];
}
export declare function validateArgvAgainstCatalog(catalog: readonly HelpCatalogCommand[], argv: readonly string[]): HelpCatalogValidationResult;
export declare function buildV3HelpCatalog(): HelpCatalogCommand[];
export declare function registerHelpJsonCommand(program: Command): void;
//# sourceMappingURL=help-json.d.ts.map