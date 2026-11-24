/**
 * OCR (open-code-review) tool configuration.
 *
 * The review-model pin persists in the API manager file (`api-manager.json`,
 * ocr section) so model selection stays co-located with the API manager UI.
 */
import {
  fileExists,
  isRecord,
  readModelsRoot,
  serializeMutation,
  writeModelsRoot,
} from "../providers/api-provider-ops.ts";

export const OCR_SECTION = "ocr";

export interface OcrConfig {
  /**
   * Model used for `ocr review` managed reviews.
   * - "session": follow the currently selected session model.
   * - "provider/modelId": pin a dedicated model from models.json.
   */
  modelRef: string;
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  modelRef: "session",
};

function normalizeConfig(value: unknown): OcrConfig {
  const record = isRecord(value) ? value : {};
  const modelRef = typeof record.modelRef === "string" && record.modelRef.trim().length > 0
    ? record.modelRef.trim()
    : DEFAULT_OCR_CONFIG.modelRef;
  return { modelRef };
}

export async function loadOcrConfig(defaultsPath: string): Promise<OcrConfig> {
  if (!await fileExists(defaultsPath)) return { ...DEFAULT_OCR_CONFIG };
  const root = await readModelsRoot(defaultsPath);
  return normalizeConfig(root[OCR_SECTION]);
}

export async function saveOcrConfig(
  config: OcrConfig,
  defaultsPath: string,
): Promise<void> {
  await serializeMutation(defaultsPath, async () => {
    const exists = await fileExists(defaultsPath);
    const root = await readModelsRoot(defaultsPath);
    await writeModelsRoot(
      { ...root, version: 1, [OCR_SECTION]: { ...config } },
      defaultsPath,
      exists,
    );
  });
}
