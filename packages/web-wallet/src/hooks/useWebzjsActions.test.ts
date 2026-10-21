import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Everything the vi.mock factories reference must be hoisted along with them.
const h = vi.hoisted(() => {
  // Order of persistence and state changes, recorded by the mocks.
  const calls: string[] = [];
  const origins = { map: new Map<object, { epoch: number | null; birthday: number | null }>() };
  const saveWallet = vi.fn(
    async (...args: [object, Uint8Array, { force?: boolean; reason: string }]) => {
      const opts = args[2];
      calls.push(`save:${opts.reason}:${opts.force ? 'forced' : 'checked'}`);
      return { epoch: 7, birthday: 2_400_000, fullyScanned: null, savedAt: 0, writerId: 't', reason: opts.reason };
    },
  );
  const markSuperseded = vi.fn((...args: [object]) => calls.push(`supersede:${args.length}`));
  const registerWallet = vi.fn();
  const readWalletBackup = vi.fn(async () => null);
  interface Staged {
    v: 2;
    bytes: Uint8Array;
    meta: { epoch: number; birthday: number | null; fullyScanned: number | null; chainTip: number | null };
  }
  const stageWallet = vi.fn(async (_w: object, _b: Uint8Array, opts: { fullyScanned: number | null }) => {
    calls.push(`stage:${opts.fullyScanned}`);
  });
  const promoteStaging = vi.fn(async () => {
    calls.push('promote');
    return { epoch: 8, birthday: 2_400_000, fullyScanned: null, savedAt: 0, writerId: 't', reason: 'resync' };
  });
  const readStaging = vi.fn(async (): Promise<Staged | null> => null);
  const clearStaging = vi.fn(async () => {
    calls.push('clear-staging');
  });
  let instances = 0;
  const live = {
    snapState: null as { webWalletSyncStartBlock: string } | null,
    contextState: {} as Record<string, unknown>,
    /** Results handed out by sync_step, in order; exhausted means "no more work". */
    stepResults: [] as boolean[],
    /** Called at the start of each step, with the number of steps attempted before it. */
    onStep: null as ((steps: number) => void | Promise<void>) | null,
    stepsTaken: 0,
  };
  class FakeWallet {
    summary = { fully_scanned_height: 3_522_000, account_balances: [[0, { orchard_balance: 10 }]] };
    name: string;
    bytes: Uint8Array | null;
    instance_id: string;
    closed = false;
    constructor(_net?: string, _url?: string, _a?: number, _b?: number, bytes: Uint8Array | null = null, name = 'fresh') {
      this.name = name;
      this.bytes = bytes;
      this.instance_id = `${name}-${++instances}`;
      calls.push(`new:${name}:${bytes ? 'from-bytes' : 'empty'}`);
    }
    async get_wallet_summary() {
      return this.summary;
    }
    async get_latest_block() {
      return 3_522_001n;
    }
    async create_account_ufvk(_n: string, _k: string, _f: unknown, _i: number, birthday?: number) {
      calls.push(`create_account:${birthday}`);
      return 0;
    }
    async sync_step(first: boolean) {
      // Counts attempts, including ones onStep fails; onStep sees the number before this one.
      const attempted = live.stepsTaken++;
      await live.onStep?.(attempted);
      calls.push(`step:${this.name}:${first ? 'first' : 'next'}`);
      return live.stepResults.length > 0 ? live.stepResults.shift()! : false;
    }
    async db_to_bytes() {
      return new Uint8Array([1, 2, 3]);
    }
    close() {
      this.closed = true;
      calls.push(`close:${this.name}`);
    }
    is_closed() {
      return this.closed;
    }
  }
  const dispatch = vi.fn((action: { type: string }) => calls.push(`dispatch:${action.type}`));
  const reloadWallet = vi.fn(async () => calls.push('reload'));
  return {
    calls, origins, saveWallet, markSuperseded, registerWallet, readWalletBackup, stageWallet, promoteStaging,
    readStaging, clearStaging, FakeWallet, dispatch, reloadWallet, live,
  };
});

vi.mock('../storage/walletStore', async () => {
  const actual = await vi.importActual<typeof import('../storage/walletStore')>('../storage/walletStore');
  return {
    ...actual,
    saveWallet: (...args: Parameters<typeof h.saveWallet>) => h.saveWallet(...args),
    markSuperseded: (w: object) => h.markSuperseded(w),
    registerWallet: (w: object, origin: { epoch: number | null; birthday: number | null }) => {
      h.origins.map.set(w, origin);
      h.registerWallet(w, origin);
    },
    walletOrigin: (w: object) => h.origins.map.get(w),
    readWalletBackup: () => h.readWalletBackup(),
    stageWallet: (...args: Parameters<typeof h.stageWallet>) => h.stageWallet(...args),
    promoteStaging: (...args: Parameters<typeof h.promoteStaging>) => h.promoteStaging(...args),
    readStaging: () => h.readStaging(),
    clearStaging: () => h.clearStaging(),
  };
});

vi.mock('@zcashcommunitygrants/webzjs-wallet', () => ({
  WebWallet: h.FakeWallet,
  SeedFingerprint: { from_bytes: (b: Uint8Array) => b },
}));

vi.mock('../context/WebzjsContext', () => ({
  useWebZjsContext: () => ({ state: h.live.contextState, dispatch: h.dispatch, reloadWallet: h.reloadWallet }),
}));
vi.mock('../context/MetamaskContext', () => ({
  useMetaMaskContext: () => ({ refreshSnapState: vi.fn(), snapState: h.live.snapState }),
}));
vi.mock('./snaps/useMetaMask', () => ({ useMetaMask: () => ({ installedSnap: { id: 'snap' } }) }));
vi.mock('./snaps/useRequestSnap', () => ({ useRequestSnap: () => vi.fn() }));
vi.mock('./snaps/useInvokeSnap', () => ({
  useInvokeSnap: () => async ({ method }: { method: string }) => {
    if (method === 'getSnapStete') return h.live.snapState;
    if (method === 'getViewingKey') return 'ufvk';
    if (method === 'getSeedFingerprint') return 'aa'.repeat(32);
    return null;
  },
}));
vi.mock('idb-keyval', () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) }));

import { useWebZjsActions } from './useWebzjsActions';
import { StaleWalletError } from '../storage/walletStore';

describe('useWebZjsActions persistence rules', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.origins.map = new Map();
    h.saveWallet.mockClear();
    h.markSuperseded.mockClear();
    h.registerWallet.mockClear();
    h.dispatch.mockClear();
    h.reloadWallet.mockClear();
    h.stageWallet.mockClear();
    h.promoteStaging.mockClear();
    h.readStaging.mockReset().mockResolvedValue(null);
    h.clearStaging.mockClear();
    h.live.snapState = { webWalletSyncStartBlock: '2600000' };
    h.live.stepResults = [];
    h.live.onStep = null;
    h.live.stepsTaken = 0;
    h.live.contextState = {
      webWallet: new h.FakeWallet('main', 'url', 1, 1, null, 'old'),
      loading: false,
      initialized: true,
      activeAccount: 0,
      summary: undefined,
      chainHeight: undefined,
      syncInProgress: false,
      storedWalletUnreadable: null,
      isWriter: true,
      resumableResync: null,
    };
  });

  it('full resync steps until the wallet has no more work, checkpointing every 4 steps and at the end', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    h.live.stepResults = [true, true, true, true, true, true, true, true, true, false];
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync(3_000_000);
    });

    const steps = h.calls.filter((c) => c.startsWith('step:fresh:'));
    expect(steps).toHaveLength(10);
    expect(steps[0]).toBe('step:fresh:first');
    expect(steps.slice(1).every((c) => c === 'step:fresh:next')).toBe(true);
    expect(h.stageWallet).toHaveBeenCalledTimes(3);
    const stageIndexes = h.calls.map((c, i) => (c.startsWith('stage:') ? i : -1)).filter((i) => i >= 0);
    const stepIndexes = h.calls.map((c, i) => (c.startsWith('step:fresh') ? i : -1)).filter((i) => i >= 0);
    expect(stageIndexes[0]).toBeGreaterThan(stepIndexes[3]);
    expect(stageIndexes[0]).toBeLessThan(stepIndexes[4]);
    expect(stageIndexes[1]).toBeGreaterThan(stepIndexes[7]);
    expect(stageIndexes[1]).toBeLessThan(stepIndexes[8]);
    expect(stageIndexes[2]).toBeGreaterThan(stepIndexes[9]);
    expect(h.stageWallet).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Uint8Array),
      { birthday: 3_000_000, fullyScanned: 3_522_000, chainTip: 3_522_001 },
    );
    expect(h.calls).toContain('create_account:3000000');
    expect(h.saveWallet).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('full resync promotes the checkpoint before making the wallet visible and closes the old instance after', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    h.live.stepResults = [true, false];
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync();
    });

    const promote = h.calls.indexOf('promote');
    const closeOld = h.calls.indexOf('close:old');
    const supersede = h.calls.indexOf('supersede:1');
    const swap = h.calls.indexOf('dispatch:set-web-wallet');
    const lastStage = h.calls.lastIndexOf('stage:3522000');
    expect(promote).toBeGreaterThan(lastStage);
    expect(closeOld).toBeGreaterThan(promote);
    expect(supersede).toBeGreaterThan(promote);
    expect(swap).toBeGreaterThan(closeOld);
    expect(swap).toBeGreaterThan(supersede);
    expect(h.promoteStaging).toHaveBeenCalledTimes(1);
    expect(h.markSuperseded).toHaveBeenCalledWith(oldWallet);
    expect(h.calls).not.toContain('close:fresh');
    expect(h.calls).not.toContain('clear-staging');
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'set-resumable-resync', payload: null });
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('full resync aborted between steps drops the checkpoint and keeps the old wallet', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    h.live.stepResults = [true, true, true, true, true, true, true, true, true, false];
    const controller = new AbortController();
    h.live.onStep = (steps) => {
      if (steps === 5) controller.abort();
    };
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync(undefined, { signal: controller.signal });
    });

    // Step 6 was already running when the abort came; the loop stops before step 7.
    expect(h.calls.filter((c) => c.startsWith('step:fresh:'))).toHaveLength(6);
    expect(h.stageWallet).toHaveBeenCalledTimes(1);
    expect(h.clearStaging).toHaveBeenCalledTimes(1);
    expect(h.promoteStaging).not.toHaveBeenCalled();
    expect(h.calls).toContain('close:fresh');
    expect(h.calls).not.toContain('close:old');
    expect(h.markSuperseded).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-web-wallet' }));
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('full resync that fails keeps the old wallet and offers the checkpoint for resume', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    h.live.stepResults = [true, true, true, true, true];
    h.live.onStep = (steps) => {
      if (steps === 5) throw new Error('this wallet instance was closed; reload the wallet');
    };
    h.readStaging.mockResolvedValue({
      v: 2,
      bytes: new Uint8Array([9]),
      meta: { epoch: 4, birthday: 2_400_000, fullyScanned: 2_410_000, chainTip: 3_522_001 },
    });
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync();
    });

    expect(h.calls.filter((c) => c.startsWith('step:fresh:'))).toHaveLength(5);
    expect(h.promoteStaging).not.toHaveBeenCalled();
    expect(h.clearStaging).not.toHaveBeenCalled();
    expect(h.calls).toContain('close:fresh');
    expect(h.calls).not.toContain('close:old');
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
    expect(h.dispatch).toHaveBeenCalledWith({
      type: 'set-resumable-resync',
      payload: { birthday: 2_400_000, fullyScanned: 2_410_000, chainTip: 3_522_001 },
    });
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-web-wallet' }));
  });

  it('resuming builds the wallet from the checkpoint bytes and does not import the account', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    h.readStaging.mockResolvedValue({
      v: 2,
      bytes: new Uint8Array([9, 9]),
      meta: { epoch: 4, birthday: 2_600_000, fullyScanned: 2_900_000, chainTip: 3_522_001 },
    });
    h.live.stepResults = [true, false];
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync(undefined, { resume: true });
    });

    expect(h.calls).toContain('new:fresh:from-bytes');
    expect(h.calls).not.toContain('new:fresh:empty');
    expect(h.calls.some((c) => c.startsWith('create_account:'))).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('step:fresh:'))).toEqual(['step:fresh:first', 'step:fresh:next']);
    expect(h.stageWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Uint8Array),
      expect.objectContaining({ birthday: 2_600_000 }),
    );
    expect(h.calls.indexOf('promote')).toBeLessThan(h.calls.indexOf('dispatch:set-web-wallet'));
    expect(h.calls).toContain('close:old');
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('resuming without a checkpoint fails without touching the old wallet', async () => {
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync(undefined, { resume: true });
    });

    expect(h.calls.some((c) => c.startsWith('new:fresh:'))).toBe(false);
    expect(h.calls).not.toContain('close:old');
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('discardResync clears the checkpoint and the offer to resume', async () => {
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.discardResync();
    });

    expect(h.clearStaging).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'set-resumable-resync', payload: null });
  });

  it('full resync prefers the stored wallet birthday over a later snap value', async () => {
    h.origins.map.set(h.live.contextState.webWallet as object, { epoch: 3, birthday: 2_400_000 });
    h.live.snapState = { webWalletSyncStartBlock: '2600000' };
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync();
    });

    expect(h.calls).toContain('create_account:2400000');
  });

  it('periodic rescan steps until the wallet has no more work and then saves', async () => {
    h.live.stepResults = [true, true, false];
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.triggerRescan();
    });

    expect(h.calls.filter((c) => c.startsWith('step:old:'))).toEqual(['step:old:first', 'step:old:next', 'step:old:next']);
    expect(h.calls.lastIndexOf('step:old:next')).toBeLessThan(h.calls.indexOf('save:sync:checked'));
    expect(h.saveWallet).toHaveBeenCalledTimes(1);
  });

  it('periodic rescan stops without saving once its instance is closed', async () => {
    const wallet = h.live.contextState.webWallet as InstanceType<typeof h.FakeWallet>;
    h.live.stepResults = [true, true, true];
    h.live.onStep = (steps) => {
      // Closed while the second step runs: the loop notices before starting a third.
      if (steps === 1) wallet.close();
    };
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.triggerRescan();
    });

    expect(h.calls.filter((c) => c.startsWith('step:old:'))).toHaveLength(2);
    expect(h.saveWallet).not.toHaveBeenCalled();
  });

  it('does not retry a sync step once the instance was closed or the worker trapped', async () => {
    const { result } = renderHook(() => useWebZjsActions());

    h.live.onStep = () => {
      throw new Error('this wallet instance was closed; reload the wallet');
    };
    await act(async () => {
      await result.current.triggerRescan();
    });
    expect(h.live.stepsTaken).toBe(1);

    h.live.onStep = () => {
      throw new Error('the sync worker stopped after an internal error; reload the page');
    };
    await act(async () => {
      await result.current.triggerRescan();
    });
    expect(h.live.stepsTaken).toBe(2);
    expect(h.saveWallet).not.toHaveBeenCalled();
  });

  it('retries a sync step after an ordinary failure', async () => {
    vi.useFakeTimers();
    try {
      let failures = 0;
      h.live.onStep = () => {
        if (failures++ === 0) throw new Error('grpc: connection reset');
      };
      const { result } = renderHook(() => useWebZjsActions());

      await act(async () => {
        const run = result.current.triggerRescan();
        await vi.advanceTimersByTimeAsync(3000);
        await run;
      });

      expect(h.live.stepsTaken).toBe(2);
      expect(h.saveWallet).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushDbToStore reloads instead of erroring when storage has moved on', async () => {
    h.saveWallet.mockRejectedValueOnce(new StaleWalletError(2, 5));
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.flushDbToStore('sync');
    });

    expect(h.reloadWallet).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
  });

  it('recoverWallet refuses to run over unreadable stored data unless told to replace it', async () => {
    h.live.contextState.storedWalletUnreadable = { error: 'bad' };
    const { result } = renderHook(() => useWebZjsActions());

    await expect(result.current.recoverWallet()).rejects.toThrow(/could not be read/);
    expect(h.saveWallet).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.recoverWallet({ replaceUnreadable: true });
    });
    expect(h.saveWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: 'recover', force: true }),
    );
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'set-stored-wallet-unreadable', payload: null });
  });
});
