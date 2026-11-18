/**
 * Recognizes the browser's report of a trap inside the wasm sync worker.
 *
 * A Rust panic compiled to wasm becomes `RuntimeError: unreachable`. It happens on the worker
 * thread, so it never rejects the promise of the call that caused it; the browser delivers it
 * to the window's `error` event (or, through a promise inside the worker shim, to
 * `unhandledrejection`). The page has to notice it there and tell the wasm module, or every
 * later sync call would hang forever waiting for a worker that stopped taking requests.
 */
export function isWasmTrapEvent(message: unknown, error: unknown): boolean {
  if (/unreachable/.test(String(message ?? ''))) return true;
  if (error === undefined || error === null) return false;
  return /RuntimeError/.test(String(error));
}
