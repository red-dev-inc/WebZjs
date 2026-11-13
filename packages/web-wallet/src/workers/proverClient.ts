// Main-thread client for the proving worker. Spawns it lazily and round-trips
// serialized PCZT bytes, so the Atomics.wait-based prover never runs on main.
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./prover.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, pcztBytes, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(new Uint8Array(pcztBytes));
      else p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Prover worker error');
      pending.forEach((p) => p.reject(err));
      pending.clear();
    };
  }
  return worker;
}

export function provePcztInWorker(pcztBytes: Uint8Array): Promise<Uint8Array> {
  const w = getWorker();
  const id = ++seq;
  const copy = pcztBytes.slice(); // transfer a copy; keep the caller's bytes intact
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, pcztBytes: copy }, [copy.buffer]);
  });
}
