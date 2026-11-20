/** One HTTP callback cancellation scope; no browser-supplied operation identity. */
export interface NativeRequestLifetime {
  readonly aborted: boolean;
  once(event: "aborted", listener: () => void): unknown;
  off(event: "aborted", listener: () => void): unknown;
}
export interface NativeResponseLifetime {
  readonly writableEnded: boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}
export function createNativeHttpOperation(req: NativeRequestLifetime, res: NativeResponseLifetime, appSignal: AbortSignal): {
  signal: AbortSignal; dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableEnded) abort(); };
  req.once("aborted", abort);
  res.once("close", close);
  appSignal.addEventListener("abort", abort, { once: true });
  if (req.aborted || appSignal.aborted) abort();
  return { signal: controller.signal, dispose() {
    req.off("aborted", abort); res.off("close", close); appSignal.removeEventListener("abort", abort);
  } };
}
