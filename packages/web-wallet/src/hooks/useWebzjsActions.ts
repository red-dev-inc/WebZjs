import { set, get } from 'idb-keyval';
import { useCallback, useRef } from 'react';
import { useWebZjsContext } from '../context/WebzjsContext';
import { useMetaMaskContext } from '../context/MetamaskContext';
import { useMetaMask } from './snaps/useMetaMask';
import { useInvokeSnap } from './snaps/useInvokeSnap';
import { useRequestSnap } from './snaps/useRequestSnap';
import { SeedFingerprint, WebWallet } from '@zcashcommunitygrants/webzjs-wallet';
import { MAINNET_LIGHTWALLETD_PROXY } from '../config/constants';
import { SnapState } from '../types/snap';
import { FullResyncOptions, trackFullResync } from './fullResyncQueue';
import {
  SaveReason,
  StaleWalletError,
  clearStaging,
  markSuperseded,
  promoteStaging,
  readStaging,
  readWalletBackup,
  registerWallet,
  saveWallet,
  stageWallet,
  stagingIsResumable,
  walletOrigin,
} from '../storage/walletStore';
import { readBlobBirthday } from '../storage/walletBlobMeta';

// Sync scheduler. The WASM wallet runs every sync on one serial worker, so JS queues
// syncs rather than refusing them: a periodic rescan skips its turn while another sync
// runs, and a full resync waits for an in-flight rescan instead of failing.
// Module-level so it's shared across all hook instances and immune to stale closures,
// and the sole owner of `syncInProgress`, so one sync's completion can't clear the flag
// while another is still running.
let _syncChain: Promise<unknown> = Promise.resolve();
let _syncBusy = false;

function runExclusiveSync<T>(
  dispatch: (action: { type: 'set-sync-in-progress'; payload: boolean }) => void,
  job: () => Promise<T>,
): Promise<T> {
  const run = async () => {
    _syncBusy = true;
    dispatch({ type: 'set-sync-in-progress', payload: true });
    try {
      return await job();
    } finally {
      _syncBusy = false;
      dispatch({ type: 'set-sync-in-progress', payload: false });
    }
  };
  const result = _syncChain.then(run);
  _syncChain = result.catch(() => undefined);
  return result;
}

interface SyncOptions {
  skipBalanceCache?: boolean;
}

interface FlushOptions {
  /** Skip the stored-epoch check. Only for an explicit recovery over unreadable data. */
  force?: boolean;
}

interface RecoverOptions {
  /** Replace stored wallet bytes that could not be read. Requires an explicit user action. */
  replaceUnreadable?: boolean;
}

interface WebzjsActions {
  getAccountData: () => Promise<
    { unifiedAddress: string; transparentAddress: string } | undefined
  >;
  triggerRescan: () => Promise<void>;
  flushDbToStore: (reason?: SaveReason, options?: FlushOptions) => Promise<void>;
  syncStateWithWallet: (options?: SyncOptions) => Promise<void>;
  connectWebZjsSnap: () => Promise<void>;
  fullResync: (customBirthday?: number, options?: FullResyncOptions) => Promise<void>;
  /** Drops the checkpoint of an interrupted resync. The current wallet is not touched. */
  discardResync: () => Promise<void>;
  recoverWallet: (options?: RecoverOptions) => Promise<void>;
}

// A full resync checkpoints its progress to storage every this many sync steps (a step is one
// batch of about 2500 blocks), so a reload loses at most that much work.
const STAGE_EVERY_STEPS = 4;
// Backoff after a failed step: this doubles per consecutive failure, and the resync gives up
// after MAX_CONSECUTIVE_FAILURES in a row. There is no limit on the number of steps.
const SYNC_STEP_RETRY_DELAY = 2000;
const MAX_CONSECUTIVE_FAILURES = 4;

/**
 * Errors after which no retry can succeed: the instance was closed (it has been replaced) or
 * the sync worker trapped (only a page reload brings it back).
 */
function isUnrecoverableWalletError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('instance was closed') || message.includes('sync worker stopped');
}

/** Parses the seed fingerprint the snap returns, as hex or as a byte object. */
function seedFingerprintFromSnap(result: unknown): SeedFingerprint {
  const hexString = typeof result === 'string'
    ? result
    : typeof result === 'object' && result !== null && 'data' in result
      ? Array.from((result as { data: number[] }).data).map((b: number) => b.toString(16).padStart(2, '0')).join('')
      : String(result);
  return SeedFingerprint.from_bytes(new Uint8Array(
    (hexString.match(/.{1,2}/g) || []).map((byte: string) => parseInt(byte, 16)),
  ));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, baseDelay = 2000, label = 'operation' } = {}
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries || isUnrecoverableWalletError(err)) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms:`, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

export function useWebZjsActions(): WebzjsActions {
  const { state, dispatch, reloadWallet } = useWebZjsContext();
  const { installedSnap } = useMetaMask();
  const { refreshSnapState, snapState } = useMetaMaskContext();
  const invokeSnap = useInvokeSnap();
  const requestSnap = useRequestSnap();

  // Refs for values read inside triggerRescan but that shouldn't cause it to be recreated
  const fullySyncedRef = useRef(state.summary?.fully_scanned_height);
  const chainHeightRef = useRef(state.chainHeight);
  const currentWalletRef = useRef(state.webWallet);
  fullySyncedRef.current = state.summary?.fully_scanned_height;
  chainHeightRef.current = state.chainHeight;
  currentWalletRef.current = state.webWallet;

  /**
   * Drives `sync_step` until the wallet reports no more work. The loop is tagged with the
   * instance it started on and stops, returning false, as soon as that instance is closed or
   * no longer the one in state, so a step queued for a replaced wallet never runs on it.
   */
  const syncToTip = useCallback(async (webWallet: WebWallet): Promise<boolean> => {
    const id = webWallet.instance_id;
    let first = true;
    for (;;) {
      if (webWallet.is_closed() || currentWalletRef.current !== webWallet) {
        console.info(`Sync loop for wallet ${id} stopped: the instance was replaced`);
        return false;
      }
      const more = await withRetry(() => webWallet.sync_step(first), {
        label: `sync_step (${id})`,
        retries: 2,
        baseDelay: 3000,
      });
      first = false;
      if (!more) return true;
    }
  }, []);

  /**
   * Read-merge-write helper for snap state. Always reads existing state first,
   * merges the partial update, then writes the complete object back.
   * This prevents partial writes from wiping unrelated fields.
   *
   * If snap state lost webWalletSyncStartBlock (e.g. snap reinstall), restores
   * it from IndexedDB where it's also persisted.
   */
  const updateSnapState = useCallback(async (partial: Partial<SnapState>) => {
    const existing = await invokeSnap({ method: 'getSnapStete' }) as SnapState | null;

    // Restore birthday from IndexedDB if snap state lost it (e.g. snap reinstall)
    let birthday = existing?.webWalletSyncStartBlock;
    if (!birthday && !partial.webWalletSyncStartBlock) {
      const idbBirthday = await get('birthdayBlock') as string | undefined;
      if (idbBirthday) {
        birthday = idbBirthday;
      }
    }

    const merged: SnapState = {
      webWalletSyncStartBlock: birthday ?? '',
      lastKnownBalance: existing?.lastKnownBalance ?? null,
      hasPendingTx: existing?.hasPendingTx ?? null,
      ...partial,
    };

    // Also persist birthday to IndexedDB whenever it's being written to snap
    if (merged.webWalletSyncStartBlock) {
      await set('birthdayBlock', String(merged.webWalletSyncStartBlock));
    }

    await invokeSnap({ method: 'setSnapStete', params: merged });
    await refreshSnapState();
  }, [invokeSnap, refreshSnapState]);

  const getAccountData = useCallback(async () => {
    try {
      if (state.activeAccount === null || state.activeAccount === undefined) return; 
      
      const accountIndex = state.activeAccount;

      if (!state.webWallet) return;

      const unifiedAddress =
        await state.webWallet.get_current_address(accountIndex);

      const transparentAddress =
        await state.webWallet.get_current_address_transparent(accountIndex);

      return {
        unifiedAddress,
        transparentAddress,
      };
    } catch (error) {
      dispatch({
        type: 'set-error',
        payload: 'Cannot get active account data',
      });
      console.error(error);
    }
  }, [dispatch, state.activeAccount, state.webWallet]);

  /**
   * Caches the current total balance (confirmed + pending) in snap state for recovery
   * after cookie/IndexedDB clears. Since totalBalance now includes pending amounts
   * (per ZIP 315), the cache always reflects the correct total — no flags needed.
   *
   * Zero-protection: won't overwrite a positive cache with zeros (wallet may be
   * recovering). Pass force=true to bypass (used by fullResync).
   *
   * Dedup: skips snap IPC when shielded/unshielded haven't changed since last cache
   * (common at chain tip during repeated syncs with no new transactions).
   */
  const lastCachedBalanceRef = useRef<{ shielded: number; unshielded: number } | null>(null);

  const cacheBalanceInSnap = useCallback(async (balanceReport: {
    sapling_balance?: number;
    orchard_balance?: number;
    ironwood_balance?: number;
    unshielded_balance?: number;
    pending_change?: number;
    pending_spendable?: number;
  } | null, force = false) => {
    if (!balanceReport) return;

    const confirmed =
      (balanceReport.sapling_balance ?? 0) +
      (balanceReport.orchard_balance ?? 0) +
      (balanceReport.ironwood_balance ?? 0);
    const unshielded = balanceReport.unshielded_balance ?? 0;
    const pending = (balanceReport.pending_change ?? 0) + (balanceReport.pending_spendable ?? 0);
    const total = confirmed + unshielded + pending;

    // Don't overwrite cache with zeros (wallet may be recovering)
    // fullResync passes force=true to bypass this
    if (!force && total === 0) {
      console.info('Skipping balance cache: not caching zero balance (pass force=true to override)');
      return;
    }

    // Skip snap IPC if balance hasn't changed (avoids 3 round-trips + context re-render)
    const shieldedForCache = confirmed + pending;
    if (!force && lastCachedBalanceRef.current &&
        lastCachedBalanceRef.current.shielded === shieldedForCache &&
        lastCachedBalanceRef.current.unshielded === unshielded) {
      return;
    }

    try {
      // Cache: shielded = confirmed shielded + all pending (pending resolves to shielded)
      await updateSnapState({
        lastKnownBalance: {
          shielded: shieldedForCache,
          unshielded,
          timestamp: Date.now(),
        },
      });
      lastCachedBalanceRef.current = { shielded: shieldedForCache, unshielded };
      console.info('Cached balance in snap state:', { shielded: shieldedForCache, unshielded, total });
    } catch (error) {
      console.warn('Failed to cache balance in snap state:', error);
    }
  }, [updateSnapState]);

  const syncStateWithWallet = useCallback(async (options?: SyncOptions) => {
    if (!state.webWallet) {
      // dispatch({
      //   type: 'set-error',
      //   payload: new Error('Wallet not initialized'),
      // });
      return;
    }
    try {
      const summary = await state.webWallet.get_wallet_summary();
      if (summary) {
        dispatch({ type: 'set-summary', payload: summary });

        // Cache balance in snap state for recovery after cookie clears
        if (summary.account_balances?.length > 0 && !options?.skipBalanceCache) {
          const [, balanceReport] = summary.account_balances[0];
          await cacheBalanceInSnap(balanceReport);
        } else if (options?.skipBalanceCache) {
          console.info('Skipping balance cache update (transaction in progress)');
        }
      }
    } catch (error) {
      console.warn('Failed to sync state (will retry next interval):', error);
    }
  }, [state.webWallet, dispatch, cacheBalanceInSnap]);

  /**
   * Persists the current wallet instance. The store refuses the write if storage has moved on
   * (another tab or a resync saved a newer wallet); then this tab reloads from storage instead
   * of overwriting it.
   */
  const flushDbToStore = useCallback(async (reason: SaveReason = 'sync', options?: FlushOptions) => {
    const wallet = state.webWallet;
    if (!wallet) {
      return;
    }
    try {
      console.info('Serializing wallet and dumping to IndexedDB store');
      const bytes = await wallet.db_to_bytes();
      const meta = await saveWallet(wallet, bytes, {
        reason,
        force: options?.force,
        fullyScanned: fullySyncedRef.current ?? null,
      });
      console.info(`Wallet saved to storage (epoch ${meta.epoch})`);
    } catch (error) {
      if (error instanceof StaleWalletError) {
        console.warn('Storage holds a newer wallet than this tab; reloading instead of overwriting:', error.message);
        void reloadWallet();
        return;
      }
      console.error('Error flushing DB to store:', error);
      dispatch({ type: 'set-error', payload: String(error) });
    }
  }, [state.webWallet, dispatch, reloadWallet]);

  /**
   * The blob's own birthday is authoritative. If the snap carries a later value (a stale or
   * clobbered mirror), lower it; never raise it.
   */
  const repairSnapBirthday = useCallback(async () => {
    const wallet = state.webWallet;
    if (!wallet) return;
    const blobBirthday = walletOrigin(wallet)?.birthday;
    const snapBirthday = Number(snapState?.webWalletSyncStartBlock);
    if (blobBirthday && snapBirthday && snapBirthday > blobBirthday) {
      console.info(`Repairing snap birthday ${snapBirthday} to the wallet's own ${blobBirthday}`);
      await updateSnapState({ webWalletSyncStartBlock: String(blobBirthday) });
    }
  }, [state.webWallet, snapState, updateSnapState]);

  const connectWebZjsSnap = useCallback(async () => {
    try {
      await requestSnap();

      if (state.webWallet === null) {
        // dispatch({
        //   type: 'set-error',
        //   payload: new Error('Wallet not initialized'),
        // });
        return;
      }

      // Check if wallet already has accounts (restored from IndexedDB)
      const existingSummary = await state.webWallet.get_wallet_summary();
      if (existingSummary && existingSummary.account_balances.length > 0) {
        // Account already exists - just set it as active and sync
        const existingAccountId = existingSummary.account_balances[0][0];
        dispatch({ type: 'set-active-account', payload: existingAccountId });
        await repairSnapBirthday();
        await syncStateWithWallet();
        return;
      }

      if (state.storedWalletUnreadable) {
        throw new Error(
          'The saved wallet could not be read. Recover it from the home page before connecting.',
        );
      }

      // No existing account - create one using latest block as birthday
      // Users can do a full resync from the app if they need an earlier birthday
      const latestBlockBigInt = await state.webWallet.get_latest_block();
      const latestBlock = Number(latestBlockBigInt);
      const birthdayBlock = latestBlock;

      await updateSnapState({ webWalletSyncStartBlock: String(latestBlock) });

      const viewingKey = (await invokeSnap({
        method: 'getViewingKey',
      })) as string;

      const seedFingerprint = seedFingerprintFromSnap(await invokeSnap({
        method: 'getSeedFingerprint',
      }));

      const account_id = await state.webWallet.create_account_ufvk(
        'account-0',
        viewingKey,
        seedFingerprint,
        0,
        birthdayBlock,
      );

      dispatch({ type: 'set-active-account', payload: account_id });

      // The instance keeps the epoch it was loaded at (none for a fresh install), so the
      // save below is rejected if another tab created the account first.
      registerWallet(state.webWallet, {
        epoch: walletOrigin(state.webWallet)?.epoch ?? null,
        birthday: birthdayBlock,
      });

      await syncStateWithWallet();

      await flushDbToStore('connect');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const fullMessage = `Failed to connect to MetaMask Snap and create account: ${errorMsg}`;
      dispatch({
        type: 'set-error',
        payload: new Error(fullMessage),
      });
      throw error;
    }
  }, [
    state.webWallet,
    state.storedWalletUnreadable,
    invokeSnap,
    dispatch,
    syncStateWithWallet,
    flushDbToStore,
    updateSnapState,
    repairSnapBirthday,
    requestSnap,
  ]);

  // Instances whose snap birthday has been checked against the blob's, once each.
  const birthdayRepairedRef = useRef(new WeakSet<object>());

  const triggerRescan = useCallback(async () => {
    if (!installedSnap) {
      return;
    }

    if (state.loading) {
      dispatch({ type: 'set-error', payload: new Error('App not yet loaded') });
      return;
    }
    if (!state.webWallet) {
      // dispatch({
      //   type: 'set-error',
      //   payload: new Error('Wallet not initialized'),
      // });
      return;
    }
    if (state.activeAccount === undefined || state.activeAccount === null) {
      // No account yet - user needs to connect first. Not an error.
      return;
    }
    if (_syncBusy) {
      // Another sync (periodic or full resync) is running; the next tick will try again.
      return;
    }

    const webWallet = state.webWallet;
    await runExclusiveSync(dispatch, async () => {
      if (!birthdayRepairedRef.current.has(webWallet)) {
        birthdayRepairedRef.current.add(webWallet);
        try {
          await repairSnapBirthday();
        } catch (err) {
          console.warn('Could not repair the snap birthday (will retry next interval):', err);
          birthdayRepairedRef.current.delete(webWallet);
        }
      }
      // Check if we're already at chain tip - skip redundant syncs
      // Allow a small buffer (2 blocks) for network propagation
      const fullySyncedHeight = fullySyncedRef.current;
      const chainHeight = chainHeightRef.current ? Number(chainHeightRef.current) : 0;
      if (fullySyncedHeight && chainHeight && fullySyncedHeight >= chainHeight - 2) {
        // Already synced to chain tip, just refresh the chain height
        try {
          const latestBlock = await webWallet.get_latest_block();
          if (latestBlock && latestBlock !== chainHeightRef.current) {
            dispatch({ type: 'set-chain-height', payload: latestBlock });
            // Only sync if chain has advanced
            if (fullySyncedHeight < Number(latestBlock)) {
              if (!(await syncToTip(webWallet))) return;
              await syncStateWithWallet();
              await flushDbToStore();
            }
          }
        } catch (err) {
          console.error('Error checking chain height:', err);
        }
        return;
      }

      try {
        if (!(await syncToTip(webWallet))) return;
        await syncStateWithWallet();
        await flushDbToStore();
      } catch (err: unknown) {
        console.warn('Sync failed (will retry next interval):', err);
      }
    });
  }, [
    installedSnap,
    state.loading,
    state.webWallet,
    state.activeAccount,
    dispatch,
    syncStateWithWallet,
    flushDbToStore,
    repairSnapBirthday,
    syncToTip,
  ]);

  /**
   * Performs a full wallet resync by:
   * 1. Creating a fresh wallet in a local variable (old wallet stays in state), or, when
   *    resuming, rebuilding it from the checkpoint of an earlier resync
   * 2. Re-importing the account with the original birthday (not when resuming)
   * 3. Syncing from there one step at a time, checkpointing to `wallet.staging` every few
   *    steps so that a reload can resume instead of starting over
   * 4. Only on success: promoting the checkpoint to the stored wallet in one transaction,
   *    closing the old instance, and swapping the new one into state
   *
   * A failure before promotion leaves the old wallet untouched in state and storage and the
   * checkpoint in place for Resume. Aborting between steps drops the checkpoint.
   */
  const fullResync = useCallback(async (customBirthday?: number, options?: FullResyncOptions) => {
    if (!installedSnap) {
      dispatch({ type: 'set-error', payload: new Error('Snap not installed') });
      return;
    }
    // Queued behind any periodic rescan that is already running. The caller may cancel
    // while it waits, and between steps once it runs.
    const run = runExclusiveSync(dispatch, async () => {
      if (options?.signal?.aborted) {
        console.info('Full resync: cancelled before it started');
        return;
      }
      options?.onStart?.();
      const oldWallet = state.webWallet;
      let freshWallet: WebWallet | null = null;
      try {
        let birthdayBlock: number | undefined;
        let accountId: number;

        if (options?.resume) {
          // 1b. Rebuild the wallet from the checkpoint. The account is already in it.
          const staged = await readStaging();
          if (!staged) {
            throw new Error('There is no interrupted resync to resume');
          }
          birthdayBlock = staged.meta.birthday ?? undefined;
          console.info(
            `Full resync: resuming from the checkpoint at ${staged.meta.fullyScanned} (birthday ${birthdayBlock})`,
          );
          try {
            freshWallet = new WebWallet('main', MAINNET_LIGHTWALLETD_PROXY, 1, 1, staged.bytes);
          } catch (decodeErr) {
            await clearStaging();
            dispatch({ type: 'set-resumable-resync', payload: null });
            throw new Error(`The resync checkpoint could not be read and was discarded: ${String(decodeErr)}`);
          }
          const stagedSummary = await freshWallet.get_wallet_summary();
          if (!stagedSummary?.account_balances?.length) {
            throw new Error('The resync checkpoint holds no account');
          }
          accountId = stagedSummary.account_balances[0][0];
        } else {
          // 1. Get the stored birthday from snap state
          const snapState = (await invokeSnap({
            method: 'getSnapStete',
          })) as SnapState | null;

          // Birthday precedence: the value typed in, then the current wallet's own birthday
          // (read from its stored bytes), then the snap's mirror. A custom birthday is only
          // persisted once the resync succeeds (step 7), so a failed resync leaves the old
          // wallet and its stored birthday consistent.
          birthdayBlock = customBirthday
            ?? (oldWallet ? walletOrigin(oldWallet)?.birthday ?? undefined : undefined)
            ?? (snapState?.webWalletSyncStartBlock
              ? Number(snapState.webWalletSyncStartBlock)
              : undefined);

          // 2. Get credentials from snap
          const viewingKey = (await invokeSnap({
            method: 'getViewingKey',
          })) as string;

          const seedFingerprint = seedFingerprintFromSnap(await invokeSnap({
            method: 'getSeedFingerprint',
          }));

          // 3. Create fresh wallet in LOCAL variable: old wallet stays in React state + IndexedDB
          console.info('Full resync: Creating fresh wallet (old wallet preserved as fallback)');
          freshWallet = new WebWallet('main', MAINNET_LIGHTWALLETD_PROXY, 1, 1, null);
          const created = freshWallet;

          // 4. Re-import the account with retry (makes GetTreeState gRPC call)
          console.info(`Full resync: Re-importing account with birthday ${birthdayBlock}`);
          accountId = await withRetry(
            () => created.create_account_ufvk('account-0', viewingKey, seedFingerprint, 0, birthdayBlock),
            { label: 'create_account_ufvk', retries: 3, baseDelay: 2000 },
          );
        }
        const wallet = freshWallet;
        // Never persisted as `wallet` yet; the birthday is the fallback for the checkpoint metadata.
        registerWallet(wallet, { epoch: null, birthday: birthdayBlock ?? null });

        // 5. Sync one bounded step at a time. Every STAGE_EVERY_STEPS steps, and once the
        //    wallet reports no more work, the progress so far is checkpointed to storage.
        //    `first` refreshes the subtree roots: on the first step, and again after a pause.
        console.info('Full resync: Starting sync');
        let first = true;
        let steps = 0;
        let consecutiveFailures = 0;
        for (;;) {
          if (options?.signal?.aborted) {
            console.info(`Full resync: cancelled after ${steps} steps; dropping the checkpoint`);
            await clearStaging();
            dispatch({ type: 'set-resumable-resync', payload: null });
            wallet.close();
            return;
          }
          let more: boolean;
          try {
            more = await wallet.sync_step(first);
            first = false;
            consecutiveFailures = 0;
          } catch (syncErr) {
            consecutiveFailures++;
            console.debug(`Full resync: step ${steps + 1} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, syncErr);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || isUnrecoverableWalletError(syncErr)) {
              throw syncErr;
            }
            const backoff = SYNC_STEP_RETRY_DELAY * Math.pow(2, consecutiveFailures - 1);
            console.debug(`Full resync: backing off ${backoff}ms before retrying`);
            await new Promise(r => setTimeout(r, backoff));
            first = true;
            continue;
          }
          steps++;

          if (steps % STAGE_EVERY_STEPS === 0 || !more) {
            const bytes = await wallet.db_to_bytes();
            const summary = await wallet.get_wallet_summary();
            const chainTip = Number(await wallet.get_latest_block());
            const scannedHeight = summary?.fully_scanned_height ?? null;
            await stageWallet(wallet, bytes, {
              birthday: birthdayBlock ?? null,
              fullyScanned: scannedHeight,
              chainTip: Number.isFinite(chainTip) ? chainTip : null,
            });
            console.info(
              `Full resync: checkpointed after ${steps} steps at ${scannedHeight} / ${chainTip} (${bytes.length} bytes)`,
            );
          }
          if (!more) break;
        }

        // 6. SUCCESS: promote the checkpoint to the stored wallet in one transaction, with its
        //    birthday, superseding whatever is stored. Only then make it visible. A failure
        //    before this point leaves storage untouched (the checkpoint can be resumed); after
        //    it, storage already holds the resynced wallet, so nothing that follows can lose it.
        const summary = await wallet.get_wallet_summary();
        const chainHeight = await wallet.get_latest_block();
        const promoted = await promoteStaging(wallet);
        console.info(`Full resync: promoted as epoch ${promoted.epoch}, swapping wallet into state`);

        // 7. Retire the old instance (no step queued for it can write into it any more) and
        //    swap the fresh one in.
        if (oldWallet) {
          oldWallet.close();
          markSuperseded(oldWallet);
        }
        dispatch({ type: 'set-resumable-resync', payload: null });
        dispatch({ type: 'set-web-wallet', payload: wallet });
        dispatch({ type: 'set-active-account', payload: accountId });
        if (summary) {
          dispatch({ type: 'set-summary', payload: summary });
        }
        if (chainHeight) {
          dispatch({ type: 'set-chain-height', payload: chainHeight });
        }

        // 8. Snap state is a backup; a failure here is repaired on the next sync.
        try {
          if (customBirthday) {
            await updateSnapState({ webWalletSyncStartBlock: String(customBirthday) });
          }
          if (summary?.account_balances?.length) {
            const [, balanceReport] = summary.account_balances[0];
            await cacheBalanceInSnap(balanceReport, true);
          }
        } catch (snapErr) {
          console.warn('Full resync: could not update snap state (will be repaired later):', snapErr);
        }

        console.info('Full resync: Complete');
      } catch (err: unknown) {
        // FAILURE: old wallet remains in state + IndexedDB, user sees last known balances.
        // The checkpoint, if one was taken, is offered for Resume.
        console.error('Full resync failed (old wallet preserved):', err);
        dispatch({ type: 'set-error', payload: String(err) });
        try {
          freshWallet?.close();
        } catch (closeErr) {
          console.warn('Full resync: could not close the abandoned instance:', closeErr);
        }
        try {
          const staged = await readStaging();
          dispatch({
            type: 'set-resumable-resync',
            payload: staged && stagingIsResumable(staged.meta)
              ? { birthday: staged.meta.birthday, fullyScanned: staged.meta.fullyScanned, chainTip: staged.meta.chainTip }
              : null,
          });
        } catch (readErr) {
          console.warn('Full resync: could not read the checkpoint:', readErr);
        }
      }
    });
    await trackFullResync(run);
  }, [installedSnap, state.webWallet, invokeSnap, dispatch, updateSnapState, cacheBalanceInSnap]);

  const discardResync = useCallback(async () => {
    await clearStaging();
    dispatch({ type: 'set-resumable-resync', payload: null });
  }, [dispatch]);

  /**
   * Recovers the wallet from snap credentials when IndexedDB data is empty or incompatible.
   * This is used for auto-recovery when the snap is reinstalled or upgraded.
   *
   * Key insight: Snap credentials (viewing key, seed fingerprint) are derived from
   * MetaMask's BIP44 seed - they survive reinstallation.
   */
  const recoverWallet = useCallback(async (options?: RecoverOptions) => {
    if (!state.webWallet) {
      throw new Error('Wallet not initialized');
    }
    if (state.storedWalletUnreadable && !options?.replaceUnreadable) {
      throw new Error(
        'The saved wallet data could not be read and was kept. Use "Discard and recover" to replace it.',
      );
    }

    console.info('Auto-recovery: Attempting to recover wallet from snap credentials');

    // 1. Get credentials from snap (derived from MetaMask seed)
    const viewingKey = (await invokeSnap({ method: 'getViewingKey' })) as string;
    const seedFingerprint = seedFingerprintFromSnap(await invokeSnap({ method: 'getSeedFingerprint' }));

    // 2. Birthday: the unreadable wallet's own birthday when replacing it, then the snap,
    //    then the IndexedDB mirror, then the chain tip (a genuinely new wallet).
    let birthdayBlock: number | undefined;
    if (options?.replaceUnreadable) {
      const backup = await readWalletBackup();
      birthdayBlock = backup
        ? readBlobBirthday(backup.bytes) ?? backup.meta?.birthday ?? undefined
        : undefined;
    }
    if (!birthdayBlock) {
      const snapState = (await invokeSnap({ method: 'getSnapStete' })) as SnapState | null;
      birthdayBlock = snapState?.webWalletSyncStartBlock
        ? Number(snapState.webWalletSyncStartBlock)
        : undefined;
    }
    if (!birthdayBlock) {
      const mirrored = Number(await get('birthdayBlock'));
      birthdayBlock = Number.isFinite(mirrored) && mirrored > 0 ? mirrored : undefined;
    }
    if (!birthdayBlock) {
      console.info('Auto-recovery: No stored birthday, using latest block');
      const latestBlock = await state.webWallet.get_latest_block();
      birthdayBlock = Number(latestBlock);

      // Store for future (read-merge-write preserves lastKnownBalance)
      await updateSnapState({ webWalletSyncStartBlock: String(birthdayBlock) });
    }

    // 3. Create account with recovered credentials
    const accountId = await state.webWallet.create_account_ufvk(
      'account-0',
      viewingKey,
      seedFingerprint,
      0,
      birthdayBlock,
    );

    dispatch({ type: 'set-active-account', payload: accountId });
    registerWallet(state.webWallet, {
      epoch: walletOrigin(state.webWallet)?.epoch ?? null,
      birthday: birthdayBlock,
    });

    // 4. Sync state and persist (skip balance cache: wallet hasn't synced, balance is 0).
    //    Replacing unreadable data is the one recovery allowed to overwrite storage.
    await syncStateWithWallet({ skipBalanceCache: true });
    await flushDbToStore('recover', { force: !!options?.replaceUnreadable });
    if (options?.replaceUnreadable) {
      dispatch({ type: 'set-stored-wallet-unreadable', payload: null });
    }

    console.info('Auto-recovery: Wallet recovered successfully');
  }, [
    state.webWallet,
    state.storedWalletUnreadable,
    invokeSnap,
    dispatch,
    syncStateWithWallet,
    flushDbToStore,
    updateSnapState,
  ]);

  return {
    getAccountData,
    triggerRescan,
    flushDbToStore,
    syncStateWithWallet,
    connectWebZjsSnap,
    fullResync,
    discardResync,
    recoverWallet,
  };
}
