import { performance } from "node:perf_hooks";

/** Passive failure evidence only: no renderer probes, operation arguments or image bytes. */
export interface BrowserRunDiagnostics {
  version: 1;
  phase: "setup" | "execution" | "postprocessing" | "cleanup";
  elapsedMs: number;
  budgetMs: number;
  cleanupDurationMs: number;
  cleanupIssues: string[];
  lastOperation?: string;
  activeOperations: string[];
  activeOperationCount: number;
  unresolvedDialog?: { type: string; hint: string };
  partialText: string;
  partialTextTruncated: boolean;
  screenshots: Array<{ path?: string; mimeType: string; bytes: number }>;
  screenshotsTruncated: boolean;
}

// Preserve the original thrown Error (including its name, hints and overflow artifact path).
const failures = new WeakMap<Error, BrowserRunDiagnostics>();
export function browserRunFailureDiagnostics(error: unknown): BrowserRunDiagnostics | undefined {
  return error instanceof Error && error.name !== "AbortError" ? failures.get(error) : undefined;
}
export function attachBrowserRunFailureDiagnostics(error: unknown, diagnostics: BrowserRunDiagnostics): void {
  if (error instanceof Error && error.name !== "AbortError") failures.set(error, diagnostics);
}

export function createBrowserRunDeadline(budgetMs: number) {
  const started = performance.now();
  return {
    elapsed: () => Math.round(performance.now() - started),
    remaining: () => {
      const remaining = budgetMs - (performance.now() - started);
      if (remaining <= 0) throw new Error(`Browser operation timed out after ${budgetMs}ms.`);
      return Math.max(1, Math.ceil(remaining));
    },
  };
}

export class BrowserRunDiagnosticCapture {
  phase: BrowserRunDiagnostics["phase"] = "setup";
  dialogType?: string;
  private lastOperation?: string;
  private active = new Map<string, number>();
  private activeCount = 0;
  private text = "";
  private textTruncated = false;

  operation = (name: string): (() => void) => {
    this.lastOperation = name.slice(0, 100);
    this.activeCount++;
    const tracked = this.active.has(this.lastOperation) || this.active.size < 16 ? this.lastOperation : undefined;
    if (tracked !== undefined) this.active.set(tracked, (this.active.get(tracked) ?? 0) + 1);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.activeCount--;
      if (tracked !== undefined) {
        const count = this.active.get(tracked)! - 1;
        if (count === 0) this.active.delete(tracked);
        else this.active.set(tracked, count);
      }
    };
  };

  captureText(text: string): void {
    const remaining = 8_192 - this.text.length;
    const piece = `${this.text ? "\n" : ""}${text}`;
    this.text += piece.slice(0, Math.max(0, remaining));
    if (piece.length > remaining) this.textTruncated = true;
  }

  snapshot(elapsedMs: number, budgetMs: number, screenshots: BrowserRunDiagnostics["screenshots"]): BrowserRunDiagnostics {
    return {
      version: 1, phase: this.phase, elapsedMs, budgetMs, cleanupDurationMs: 0, cleanupIssues: [],
      lastOperation: this.lastOperation,
      activeOperations: [...this.active.keys()],
      activeOperationCount: this.activeCount,
      unresolvedDialog: this.dialogType ? {
        type: this.dialogType.slice(0, 32),
        hint: "A JavaScript dialog is still open and may block this operation. Configure dialogs on open, or explicitly handle the dialog; do not replay earlier actions.",
      } : undefined,
      partialText: this.text, partialTextTruncated: this.textTruncated,
      screenshots: screenshots.slice(0, 8).map(({ path, mimeType, bytes }) => ({ path: path?.slice(0, 1_024), mimeType: mimeType.slice(0, 64), bytes })),
      screenshotsTruncated: screenshots.length > 8,
    };
  }
}
