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
  class FakeWallet {
    summary = { fully_scanned_height: 3_522_000, account_balances: [[0, { orchard_balance: 10 }]] };
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
    async sync() {
      calls.push('sync');
    }
    async db_to_bytes() {
      return new Uint8Array([1, 2, 3]);
    }
  }
  const dispatch = vi.fn((action: { type: string }) => calls.push(`dispatch:${action.type}`));
  const reloadWallet = vi.fn(async () => calls.push('reload'));
  const live = {
    snapState: null as { webWalletSyncStartBlock: string } | null,
    contextState: {} as Record<string, unknown>,
  };
  return { calls, origins, saveWallet, markSuperseded, registerWallet, readWalletBackup, FakeWallet, dispatch, reloadWallet, live };
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
    h.live.snapState = { webWalletSyncStartBlock: '2600000' };
    h.live.contextState = {
      webWallet: new h.FakeWallet(),
      loading: false,
      initialized: true,
      activeAccount: 0,
      summary: undefined,
      chainHeight: undefined,
      syncInProgress: false,
      storedWalletUnreadable: null,
      isWriter: true,
    };
  });

  it('full resync persists the fresh wallet as a forced write before making it visible', async () => {
    const oldWallet = h.live.contextState.webWallet as object;
    h.origins.map.set(oldWallet, { epoch: 3, birthday: 2_400_000 });
    const { result } = renderHook(() => useWebZjsActions());

    await act(async () => {
      await result.current.fullResync(3_000_000);
    });

    const save = h.calls.indexOf('save:resync:forced');
    const swap = h.calls.indexOf('dispatch:set-web-wallet');
    const supersede = h.calls.indexOf('supersede:1');
    expect(save).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(save);
    expect(supersede).toBeGreaterThan(save);
    expect(supersede).toBeLessThan(swap);
    expect(h.markSuperseded).toHaveBeenCalledWith(oldWallet);
    expect(h.calls).toContain('create_account:3000000');
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set-error' }));
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
