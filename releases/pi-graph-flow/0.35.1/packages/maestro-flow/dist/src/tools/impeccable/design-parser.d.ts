interface NamedRule {
    name: string;
    body: string;
}
interface ColorEntry {
    name: string | null;
    value: string;
    valueRange: string[] | null;
    format: string;
    description: string | null;
}
interface ColorGroup {
    role: string;
    colors: ColorEntry[];
}
interface FontSpec {
    family: string;
    fallback: string | null;
    purpose?: string;
}
interface TypeBullet {
    name: string;
    specs: string[];
    purpose: string | null;
}
interface ShadowEntry {
    name: string | null;
    value: string;
    purpose: string | null;
}
interface ComponentVariant {
    name: string;
    description: string;
}
interface ComponentEntry {
    name: string;
    description: string | null;
    properties: Record<string, string>;
    variants: ComponentVariant[];
}
export interface DesignModel {
    schemaVersion: 2;
    title: string | null;
    frontmatter: Record<string, unknown> | null;
    overview: {
        subtitle: string | null;
        creativeNorthStar: string | null;
        philosophy: string[];
        keyCharacteristics: string[];
    } | null;
    colors: {
        subtitle: string | null;
        description: string | null;
        groups: ColorGroup[];
        rules: NamedRule[];
    } | null;
    typography: {
        subtitle: string | null;
        fonts: Record<string, FontSpec>;
        character: string | null;
        hierarchy: TypeBullet[];
        rules: NamedRule[];
    } | null;
    elevation: {
        subtitle: string | null;
        description: string | null;
        shadows: ShadowEntry[];
        rules: NamedRule[];
    } | null;
    components: {
        subtitle: string | null;
        components: ComponentEntry[];
    } | null;
    dosDonts: {
        dos: string[];
        donts: string[];
    } | null;
}
export interface CoverageReport {
    overview: unknown;
    colors: unknown;
    typography: unknown;
    elevation: unknown;
    components: unknown;
    dosDonts: unknown;
}
export declare function assessCoverage(model: DesignModel): CoverageReport;
export declare function parseDesignMd(md: string): DesignModel;
export {};
//# sourceMappingURL=design-parser.d.ts.map