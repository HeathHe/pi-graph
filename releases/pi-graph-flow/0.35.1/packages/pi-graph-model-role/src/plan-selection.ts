/** Main-session temporary choice only; this object grants no child-role permission. */
export class TemporaryPlanSelection<Model extends { provider: string; id: string }> {
  #original: Model | undefined;
  get original(): Model | undefined { return this.#original; }
  /** Capture before a host switch which may fail after partially changing state. */
  rememberBeforeSwitch(model: Model | undefined): void {
    if (this.#original === undefined && model !== undefined) this.#original = model;
  }
  /** Only the host's successful restore receipt may clear the retained reference. */
  restored(): void { this.#original = undefined; }
}
export function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}
