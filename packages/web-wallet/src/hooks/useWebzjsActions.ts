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
  markSuperseded,
  readWalletBackup,
  registerWallet,
  saveWallet,
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
  recoverWallet: (options?: RecoverOptions) => Promise<void>;
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
      if (attempt === retries) throw err;
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
  fullySyncedRef.current = state.summary?.fully_scanned_height;
  chainHeightRef.current = state.chainHeight;

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
    unshielded_balance?: number;
    pending_change?: number;
    pending_spendable?: number;
  } | null, force = false) => {
    if (!balanceReport) return;

    const confirmed = (balanceReport.sapling_balance ?? 0) + (balanceReport.orchard_balance ?? 0);
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
              await withRetry(() => webWallet.sync(), { label: 'sync', retries: 2, baseDelay: 3000 });
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
        await withRetry(() => webWallet.sync(), { label: 'sync', retries: 2, baseDelay: 3000 });
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
  ]);

  /**
   * Performs a full wallet resync by:
   * 1. Creating a fresh wallet in a local variable (old wallet stays in state)
   * 2. Re-importing the account with the original birthday
   * 3. Syncing from birthday with retry
   * 4. Only on success: swapping the new wallet into state + IndexedDB
   *
   * If any gRPC call fails, the old wallet remains untouched in state and IndexedDB.
   * This is a user-initiated action for recovering from sync issues.
   */
  const fullResync = useCallback(async (customBirthday?: number, options?: FullResyncOptions) => {
    if (!installedSnap) {
      dispatch({ type: 'set-error', payload: new Error('Snap not installed') });
      return;
    }
    // Queued behind any periodic rescan that is already running. The caller may cancel
    // while it waits; once the job starts it runs to completion.
    const run = runExclusiveSync(dispatch, async () => {
      if (options?.signal?.aborted) {
        console.info('Full resync: cancelled before it started');
        return;
      }
      options?.onStart?.();
      try {
        // 1. Get the stored birthday from snap state
        const snapState = (await invokeSnap({
          method: 'getSnapStete',
        })) as SnapState | null;

        // Birthday precedence: the value typed in, then the current wallet's own birthday
        // (read from its stored bytes), then the snap's mirror. A custom birthday is only
        // persisted once the resync succeeds (step 6), so a failed resync leaves the old
        // wallet and its stored birthday consistent.
        const oldWallet = state.webWallet;
        const birthdayBlock = customBirthday
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
        const freshWallet = new WebWallet('main', MAINNET_LIGHTWALLETD_PROXY, 1, 1, null);

        // 4. Re-import the account with retry (makes GetTreeState gRPC call)
        console.info(`Full resync: Re-importing account with birthday ${birthdayBlock}`);
        const accountId = await withRetry(
          () => freshWallet.create_account_ufvk('account-0', viewingKey, seedFingerprint, 0, birthdayBlock),
          { label: 'create_account_ufvk', retries: 3, baseDelay: 2000 },
        );

        // 5. Sync from birthday in a loop: each sync() makes incremental progress
        //    The Rust WASM wallet resumes from where it left off on each call.
        //    With many blocks to scan, one sync() call can't finish before the
        //    lightwalletd proxy drops the connection, so we keep calling it.
        console.info('Full resync: Starting sync from birthday');
        const MAX_SYNC_ROUNDS = 20;
        const SYNC_ROUND_DELAY = 2000; // ms between rounds to let proxy recover
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 4;

        for (let round = 1; round <= MAX_SYNC_ROUNDS; round++) {
          try {
            console.info(`Full resync: sync round ${round}/${MAX_SYNC_ROUNDS}`);
            await freshWallet.sync();
            consecutiveFailures = 0;

            // Check if fully synced
            const summary = await freshWallet.get_wallet_summary();
            const chainTip = Number(await freshWallet.get_latest_block());
            const scannedHeight = summary?.fully_scanned_height ?? 0;

            console.info(`Full resync: scanned to ${scannedHeight} / ${chainTip}`);

            if (scannedHeight >= chainTip - 2) {
              console.info('Full resync: Fully synced');
              break;
            }

            // Not done yet: pause before next round
            if (round < MAX_SYNC_ROUNDS) {
              await new Promise(r => setTimeout(r, SYNC_ROUND_DELAY));
            }
          } catch (syncErr) {
            consecutiveFailures++;
            console.debug(`Full resync: sync round ${round} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, syncErr);

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              throw syncErr; // give up after too many consecutive failures
            }

            // Back off longer after failures
            const backoff = SYNC_ROUND_DELAY * Math.pow(2, consecutiveFailures - 1);
            console.debug(`Full resync: backing off ${backoff}ms before retry`);
            await new Promise(r => setTimeout(r, backoff));
          }

          if (round === MAX_SYNC_ROUNDS) {
            console.info('Full resync: not at chain tip after the last round; the periodic rescan will finish catching up');
          }
        }

        // 6. SUCCESS: persist the fresh wallet FIRST, together with its birthday, as a forced
        //    write that supersedes whatever is stored. Only then make it visible. A failure
        //    before this point leaves storage untouched; after it, storage already holds the
        //    resynced wallet, so nothing that follows can lose it.
        const summary = await freshWallet.get_wallet_summary();
        const chainHeight = await freshWallet.get_latest_block();
        registerWallet(freshWallet, { epoch: null, birthday: birthdayBlock ?? null });
        const bytes = await freshWallet.db_to_bytes();
        const saved = await saveWallet(freshWallet, bytes, {
          reason: 'resync',
          force: true,
          birthday: birthdayBlock ?? null,
          fullyScanned: summary?.fully_scanned_height ?? null,
        });
        console.info(`Full resync: persisted as epoch ${saved.epoch}, swapping wallet into state`);

        // 7. Retire the old instance and swap the fresh one in.
        if (oldWallet) markSuperseded(oldWallet);
        dispatch({ type: 'set-web-wallet', payload: freshWallet });
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
        // FAILURE: old wallet remains in state + IndexedDB, user sees last known balances
        console.error('Full resync failed (old wallet preserved):', err);
        dispatch({ type: 'set-error', payload: String(err) });
      }
    });
    await trackFullResync(run);
  }, [installedSnap, state.webWallet, invokeSnap, dispatch, updateSnapState, cacheBalanceInSnap]);

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
    recoverWallet,
  };
}
