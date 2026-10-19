/**
 * Turns anything a failed step can throw into text a person can read.
 *
 * MetaMask snap calls reject with plain `{ code, message, data }` objects rather
 * than `Error` instances, so `String(error)` gives "[object Object]". WASM traps
 * surface as a RuntimeError whose message is just "unreachable".
 */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; data?: { originalError?: { message?: unknown } } };
    const nested = e.data?.originalError?.message;
    if (typeof nested === 'string' && nested) return nested;
    if (typeof e.message === 'string' && e.message) return e.message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return String(error);
}

/** True when the detail is a WASM trap, which carries no information of its own. */
export function isWasmTrap(detail: string): boolean {
  return detail === 'unreachable' || detail.includes('RuntimeError: unreachable');
}

export function isUserRejection(error: unknown, detail: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 4001 || /user rejected|user denied|rejected the request/i.test(detail);
}

/**
 * True when the backend refused to build the transaction because the proposal
 * needs something this wallet build does not support (a pool it does not
 * track, a multi-step proposal, a TEX recipient without transparent inputs).
 * `ProposalNotSupported` is the variant name zcash_client_backend reports and
 * the wallet formats it with Debug, so the bare name is what reaches the UI.
 */
export function isProposalNotSupported(detail: string): boolean {
  return /\bProposalNotSupported\b/.test(detail);
}

export interface FriendlyError {
  summary: string;
  detail: string;
}

export type TransferFlow = 'transfer' | 'shield';

/** The stage during which the transaction is handed to the network. */
export const BROADCAST_STAGE = 'Broadcasting the transaction';

/**
 * What the failure means for the funds. Before the broadcast nothing has left
 * the wallet; during it the outcome is unknown; after it the payment is out
 * and must not be repeated.
 */
function outcomeSentence(stage: string, broadcast: boolean): string {
  if (broadcast) {
    return 'The payment was already broadcast and may still confirm, so do not send it again; check the transaction history.';
  }
  if (stage === BROADCAST_STAGE) {
    return 'It is not certain whether the payment went out; check the transaction history before sending again.';
  }
  return 'Nothing was sent.';
}

/**
 * Builds the message shown on the transfer result card: a sentence about what
 * went wrong at the given stage, followed by the raw detail for support.
 *
 * `broadcast` is true once the network has accepted the transaction, so a
 * later failure (saving the wallet, refreshing state) does not claim that
 * nothing was sent.
 */
export function describeTransferError(
  error: unknown,
  stage: string,
  flow: TransferFlow = 'transfer',
  broadcast = false,
): FriendlyError {
  const detail = errorDetail(error);
  const outcome = outcomeSentence(stage, broadcast);
  if (isUserRejection(error, detail)) {
    return { summary: 'You declined the request in MetaMask, so nothing was sent.', detail };
  }
  if (isProposalNotSupported(detail)) {
    return {
      summary:
        flow === 'shield'
          ? 'This wallet cannot build the shielding transaction: it needs a feature this wallet version does not support yet. Nothing was sent.'
          : "This wallet cannot build a payment to that address: it needs a feature this wallet version does not support yet. Nothing was sent. Try the recipient's transparent address, or update the wallet.",
      detail,
    };
  }
  if (isWasmTrap(detail)) {
    return {
      summary: `${stage} hit an internal error in the wallet code and stopped. ${outcome} Please reload and try again; if it repeats, report the details below.`,
      detail: 'WASM trap (RuntimeError: unreachable)',
    };
  }
  return { summary: `${stage} failed. ${outcome}`, detail };
}
