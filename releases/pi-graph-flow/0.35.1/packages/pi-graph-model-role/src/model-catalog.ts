import {
  TEAMMATE_THINKING_LEVELS,
  parseTeammateThinkingLevel,
  type TeammateThinkingLevel,
} from "./thinking.ts";

/** Syntax only: authority still comes from a parsed registry projection. */
export function isRegisteredModelId(id: string): boolean {
  return id.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(id);
}

export interface AvailableModelEntry {
  provider: string;
  id: string;
  /** Opaque registration identity from the trusted registry projection.
   * provider may be empty here; it is not an upstream-provider claim. */
  registrationId?: string;
  /** Virtual selections require an inherited router, not a physical registration. */
  api?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<TeammateThinkingLevel, string | null>>;
  /** Supported input modalities; `image` marks a vision-capable model. */
  input?: readonly ("text" | "image")[];
}

export interface TeammateModelCapability {
  id: string;
  reasoning?: boolean;
  thinkingLevels?: readonly TeammateThinkingLevel[];
  /** Supported input modalities, when declared. */
  input?: readonly ("text" | "image")[];
}

export function isMultimodalEntry(model: AvailableModelEntry | TeammateModelCapability): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

export interface ModelCatalogSnapshot {
  signature: string;
  systemPrompt: string;
  modelIds: string[];
  models: TeammateModelCapability[];
}

/**
 * Declared thinking depth support for a model. The teammate layer never
 * restricts thinking depth: a reasoning model is advertised as supporting the
 * full level range, and the child Pi host clamps to its own provider-specific
 * capability boundary when a level cannot be honored. The model's
 * thinkingLevelMap is advisory (how a level maps to a provider parameter),
 * not an availability gate.
 */
export function supportedThinkingLevels(model: AvailableModelEntry): TeammateThinkingLevel[] | undefined {
  if (model.reasoning === false) return ["off"];
  if (model.reasoning !== true) return undefined;
  return [...TEAMMATE_THINKING_LEVELS];
}

const START_MARKER = "<available_teammate_models>";
const END_MARKER = "</available_teammate_models>";

function normalizedEntries(models: AvailableModelEntry[]): AvailableModelEntry[] {
  const entries = new Map<string, AvailableModelEntry>();
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (model.registrationId === undefined && (!provider || !id)) continue;
    if (model.registrationId !== undefined && !isRegisteredModelId(model.registrationId)) continue;
    const key = model.registrationId ?? `${provider}/${id}`;
    if (!entries.has(key)) entries.set(key, { ...model, provider, id });
  }
  return [...entries.values()].sort((left, right) =>
    (left.registrationId ?? `${left.provider}/${left.id}`).localeCompare(right.registrationId ?? `${right.provider}/${right.id}`),
  );
}

export function createModelCatalogSnapshot(models: AvailableModelEntry[]): ModelCatalogSnapshot {
  const entries = normalizedEntries(models);
  const modelIds = entries.map((model) => model.registrationId ?? `${model.provider}/${model.id}`);
  const capabilities = entries.map((model) => {
    const thinkingLevels = supportedThinkingLevels(model);
    return {
      id: model.registrationId ?? `${model.provider}/${model.id}`,
      reasoning: model.reasoning,
      thinkingLevels,
      ...(model.input ? { input: [...model.input] } : {}),
    };
  });
  const lines = capabilities.length > 0
    ? capabilities.map((model) => {
      const levels = model.thinkingLevels;
      const thinking = levels ? ` [thinking:${levels.join(",")}]` : model.reasoning ? " [reasoning]" : "";
      const vision = isMultimodalEntry(model) ? " [vision]" : "";
      return `- ${model.id}${thinking}${vision}`;
    })
    : ["- (none; check model configuration, role/session permissions, and connection information)"];

  return {
    signature: capabilities
      .map((model) => `${model.id}:${model.reasoning ?? "unknown"}:${model.thinkingLevels?.join(",") ?? "unknown"}:${model.input?.join(",") ?? "unknown"}`)
      .join("\n"),
    modelIds,
    models: capabilities,
    systemPrompt: `${START_MARKER}\nCurrently selectable models for this session:\n${lines.join("\n")}\n\nFor model selection and resolution precedence, follow the \`teammate\` tool description and any currently enabled smart-selection guidance. An explicit id outside this catalog fails fast at dispatch with "Unknown teammate model specifier".\n${END_MARKER}`,
  };
}

export function appendModelCatalog(
  systemPrompt: string,
  snapshot: ModelCatalogSnapshot,
): string {
  const start = systemPrompt.indexOf(START_MARKER);
  const end = systemPrompt.indexOf(END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${snapshot.systemPrompt}${systemPrompt.slice(end + END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${snapshot.systemPrompt}`;
}
