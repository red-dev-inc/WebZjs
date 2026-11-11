// Dedicated zk-proof worker. Proof generation (Sapling's Groth16 prover in
// particular) blocks on Atomics.wait, which the browser forbids on the main
// thread, so pczt_prove must run here. pczt_prove is stateless (no db/network),
// so an empty wallet instance is all it needs.
import initWebzJSWallet, {
  initThreadPool,
  WebWallet,
  Pczt,
} from '@zcashcommunitygrants/webzjs-wallet';
import { NETWORK, LIGHTWALLETD_PROXY } from '../config/constants';

interface ProveRequest {
  id: number;
  pcztBytes: Uint8Array;
}

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as {
    postMessage: (m: unknown, t?: Transferable[]) => void;
  }).postMessage(msg, transfer);

let proverPromise: Promise<WebWallet> | null = null;

function getProver(): Promise<WebWallet> {
  if (!proverPromise) {
    proverPromise = (async () => {
      await initWebzJSWallet();
      await initThreadPool(navigator.hardwareConcurrency || 4);
      return new WebWallet(NETWORK, LIGHTWALLETD_PROXY, 1, 1, null);
    })();
  }
  return proverPromise;
}

self.onmessage = async (e: MessageEvent<ProveRequest>) => {
  const { id, pcztBytes } = e.data;
  try {
    const prover = await getProver();
    const pczt = Pczt.from_bytes(new Uint8Array(pcztBytes));
    const proved = await prover.pczt_prove(pczt);
    const out = proved.serialize();
    post({ id, ok: true, pcztBytes: out }, [out.buffer]);
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
