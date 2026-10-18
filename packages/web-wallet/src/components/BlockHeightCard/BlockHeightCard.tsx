import { FC, useEffect, useRef, useState } from 'react';
import { WebZjsState } from 'src/context/WebzjsContext';
import { FullResyncOptions, pendingFullResync } from 'src/hooks/fullResyncQueue';

// Zcash mainnet activation block (Sapling activation)
const ZCASH_SAPLING_ACTIVATION = 419200;

/** Idle, waiting for a sync that is already running to finish, or resyncing. */
type ResyncPhase = 'idle' | 'queued' | 'running';

export const BlockHeightCard: FC<{
  state: WebZjsState;
  syncedFrom?: string;
  onFullResync?: (customBirthday?: number, options?: FullResyncOptions) => Promise<void>;
  /** Drops the checkpoint of an interrupted resync. */
  onDiscardResync?: () => Promise<void>;
}> = ({ state, syncedFrom, onFullResync, onDiscardResync }) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const [customBirthday, setCustomBirthday] = useState('');
  const [phase, setPhase] = useState<ResyncPhase>(() => (pendingFullResync() ? 'running' : 'idle'));
  const [birthdayError, setBirthdayError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resyncing = phase !== 'idle';

  // A resync started from an earlier mount of this card is shown until it settles, so a
  // second one cannot be queued behind it.
  useEffect(() => {
    const pending = pendingFullResync();
    if (!pending) return;
    let active = true;
    pending.finally(() => {
      if (active) setPhase('idle');
    });
    return () => {
      active = false;
    };
  }, []);

  const chainHeight = state.chainHeight ? Number(state.chainHeight) : undefined;
  const resumable = state.resumableResync;

  const startResync = async (birthday: number | undefined, resume: boolean) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('queued');
    try {
      // Queued behind any background sync that is running; the form stays open and can
      // still be cancelled until the resync itself starts.
      await onFullResync?.(birthday, {
        signal: controller.signal,
        onStart: () => setPhase('running'),
        resume,
      });
    } finally {
      abortRef.current = null;
      setPhase('idle');
      setShowConfirm(false);
      setCustomBirthday('');
    }
  };

  const handleResync = async () => {
    const birthday = customBirthday ? parseInt(customBirthday, 10) : undefined;
    if (birthday !== undefined && Number.isNaN(birthday)) {
      setBirthdayError('Birthday must be a block height');
      return;
    }
    if (birthday !== undefined && birthday < ZCASH_SAPLING_ACTIVATION) {
      setBirthdayError(`Birthday must be at least ${ZCASH_SAPLING_ACTIVATION} (Sapling activation)`);
      return;
    }
    if (birthday !== undefined && chainHeight !== undefined && birthday > chainHeight) {
      setBirthdayError(`Birthday cannot be above the chain height (${chainHeight})`);
      return;
    }
    setBirthdayError(null);
    await startResync(birthday, false);
  };

  const handleResume = () => startResync(undefined, true);

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await onDiscardResync?.();
    } finally {
      setDiscarding(false);
    }
  };

  const cancelResync = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
    setShowConfirm(false);
    setCustomBirthday('');
    setBirthdayError(null);
  };

  return (
    <div className="grow shrink min-w-[317px] basis-0 p-6 bg-white rounded-xl border border-[#afafaf] flex-col justify-start items-start gap-2 inline-flex">
      {state.syncInProgress ? (
        <div className="self-stretch flex items-center gap-2">
          <svg
            className="animate-spin h-4 w-4 text-[#595959]"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          <span className="text-[#595959] text-sm font-semibold font-inter leading-[21px]">
            Sync in progress...
          </span>
        </div>
      ) : null}
      <div className="self-stretch text-[#595959] text-sm font-semibold font-inter leading-[21px]">
        Chain Height
      </div>
      <div className="self-stretch justify-start items-center gap-2 inline-flex">
        <div className="text-black text-2xl font-medium font-['Inter'] leading-9">
          {state.chainHeight ? '' + state.chainHeight : '?'}
        </div>
      </div>
      <div className="self-stretch text-[#595959] text-sm font-semibold font-inter leading-[21px]">
        Synced Height
      </div>
      <div className="self-stretch justify-start items-center gap-2 inline-flex">
        <div className="text-black text-2xl font-medium font-['Inter'] leading-9">
          {state.summary?.fully_scanned_height
            ? state.summary?.fully_scanned_height
            : '?'}
        </div>
      </div>
      {syncedFrom && (
        <>
          <div className="self-stretch text-[#595959] text-sm font-semibold font-inter leading-[21px]">
            Sync Start Block
          </div>
          <div className="self-stretch justify-start items-center gap-2 inline-flex">
            <div className="text-black text-2xl font-medium font-['Inter'] leading-9">
              {syncedFrom}
            </div>
          </div>
        </>
      )}
      {resumable && onFullResync && (
        <div className="self-stretch mt-4 pt-4 border-t border-[#e0e0e0] flex flex-col gap-2">
          <p className="text-[#595959] text-xs">
            A resync from block {resumable.birthday ?? '?'} stopped at{' '}
            {resumable.fullyScanned ?? resumable.birthday ?? '?'} of {resumable.chainTip ?? '?'}.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleResume}
              disabled={resyncing || discarding}
              className="px-3 py-1 bg-[#f5a623] text-white text-sm font-medium rounded hover:bg-[#e09000] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {phase === 'queued'
                ? 'Waiting for the current sync…'
                : phase === 'running'
                  ? 'Resuming…'
                  : 'Resume'}
            </button>
            <button
              onClick={handleDiscard}
              disabled={resyncing || discarding}
              className="px-3 py-1 bg-[#e0e0e0] text-[#595959] text-sm font-medium rounded hover:bg-[#d0d0d0] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {discarding ? 'Discarding…' : 'Discard'}
            </button>
          </div>
        </div>
      )}
      {onFullResync && (
        <div className="self-stretch mt-4 pt-4 border-t border-[#e0e0e0]">
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={resyncing}
              className="text-[#595959] text-sm font-medium hover:text-black transition-colors cursor-pointer underline disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {resyncing ? 'Resyncing…' : 'Full Resync'}
            </button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[#595959] text-xs">
                Clear cached data and resync. Enter a custom birthday block or leave empty to use stored birthday.
              </p>
              <div className="flex flex-col gap-1">
                <label className="text-[#595959] text-xs">
                  Birthday Block (min: {ZCASH_SAPLING_ACTIVATION}
                  {chainHeight !== undefined ? `, max: ${chainHeight}` : ''})
                </label>
                <input
                  type="number"
                  value={customBirthday}
                  onChange={(e) => {
                    setCustomBirthday(e.target.value);
                    setBirthdayError(null);
                  }}
                  placeholder="e.g. 2674500"
                  min={ZCASH_SAPLING_ACTIVATION}
                  max={chainHeight}
                  disabled={resyncing}
                  className="px-2 py-1 border border-[#afafaf] rounded text-sm w-full bg-white text-black disabled:opacity-60"
                />
                {birthdayError && (
                  <p role="alert" className="text-red-600 text-xs">
                    {birthdayError}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleResync}
                  disabled={resyncing}
                  className="px-3 py-1 bg-[#f5a623] text-white text-sm font-medium rounded hover:bg-[#e09000] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {phase === 'queued'
                    ? 'Waiting for the current sync…'
                    : phase === 'running'
                      ? 'Resyncing…'
                      : 'Confirm Resync'}
                </button>
                <button
                  onClick={cancelResync}
                  disabled={phase === 'running'}
                  className="px-3 py-1 bg-[#e0e0e0] text-[#595959] text-sm font-medium rounded hover:bg-[#d0d0d0] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
