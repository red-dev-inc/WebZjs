import { useCallback, useEffect, useState } from 'react';
import { get, set, del } from 'idb-keyval';
import { Pczt } from '@zcashcommunitygrants/webzjs-wallet';
import { provePcztInWorker } from '../workers/proverClient';
import { Buffer } from 'buffer';
import { useWebZjsContext } from '../context/WebzjsContext';
import { useMetaMaskContext } from '../context/MetamaskContext';
import { useInvokeSnap } from './snaps/useInvokeSnap';
import { useWebZjsActions } from './useWebzjsActions';
import useBalance from './useBalance';
import { SnapState } from '../types/snap';

// Key for the txid of a broadcast-but-not-yet-committed migration sweep. Stored in both
// IndexedDB (fast) and Snap state (durable — survives clearing browser site data).
const PENDING_MIGRATION_TXID_KEY = 'pendingMigrationTxid';

// How long to wait for the sweep to be mined before giving up (the switch can still
// be finished later via `finishSwitching`). Poll roughly every 8s. Budget set for
// NU7's 25s blocks, where tx expiry arrives sooner in wall-clock (~17 min).
const MINED_POLL_MS = 8_000;
const MINED_MAX_ATTEMPTS = 120; // ~16 minutes

export enum MigrationStatus {
  IDLE = 'Idle',
  PREPARING = 'Preparing migration',
  CREATING = 'Building migration transaction',
  SIGNING = 'Signing with your current key',
  PROVING = 'Proving transaction',
  SENDING = 'Moving your funds',
  CONFIRMING = 'Waiting for the transaction to confirm',
  STAMPING = 'Switching to the portable account',
  RESYNCING = 'Refreshing your wallet',
  DONE = 'Migration complete',
  ERROR = 'Migration failed',
}

interface IUseMigration {
  migrateToPortable: () => Promise<void>;
  finishSwitching: () => Promise<void>;
  migrationStatus: MigrationStatus;
  migrationError: string | null;
  /** True if a sweep was broadcast but the switch to v2 hasn't been committed yet. */
  hasPendingMigration: boolean;
}

/**
 * One-time v1 → v2 sweep: move the balance to the portable address, wait for ≥1
 * confirmation, then commit the switch. The txid is persisted so it can be resumed.
 */
export const useMigration = (): IUseMigration => {
  const { state } = useWebZjsContext();
  const invokeSnap = useInvokeSnap();
  const { flushDbToStore, fullResync } = useWebZjsActions();
  const { refreshSnapState } = useMetaMaskContext();
  const {
    shieldedBalance,
    unshieldedBalance,
    totalPending,
    isCached,
    loading: balanceLoading,
  } = useBalance();

  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>(
    MigrationStatus.IDLE,
  );
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [hasPendingMigration, setHasPendingMigration] = useState(false);

  // Mirror the pending marker into Snap state so it survives clearing site data (which
  // wipes IndexedDB) and a reload on the same device can still finish the switch.
  const writePendingToSnap = async (txid: string | null): Promise<void> => {
    try {
      const existing = (await invokeSnap({
        method: 'getSnapStete',
      })) as SnapState | null;
      await invokeSnap({
        method: 'setSnapStete',
        params: {
          webWalletSyncStartBlock: existing?.webWalletSyncStartBlock ?? '',
          lastKnownBalance: existing?.lastKnownBalance ?? null,
          hasPendingTx: existing?.hasPendingTx ?? null,
          pendingMigrationTxid: txid,
        },
      });
    } catch {
      /* Snap unavailable — the IndexedDB marker still covers the common path. */
    }
  };

  const setPendingTxid = async (txid: string): Promise<void> => {
    await set(PENDING_MIGRATION_TXID_KEY, txid).catch(() => undefined);
    await writePendingToSnap(txid);
    setHasPendingMigration(true);
  };

  const clearPendingTxid = async (): Promise<void> => {
    await del(PENDING_MIGRATION_TXID_KEY).catch(() => undefined);
    await writePendingToSnap(null);
    setHasPendingMigration(false);
  };

  // Snap state first (durable), then IndexedDB (fast local cache).
  const getPendingTxid = async (): Promise<string | undefined> => {
    try {
      const s = (await invokeSnap({ method: 'getSnapStete' })) as SnapState | null;
      if (s?.pendingMigrationTxid) return s.pendingMigrationTxid;
    } catch {
      /* fall through to idb */
    }
    try {
      const t = (await get(PENDING_MIGRATION_TXID_KEY)) as string | undefined;
      return t || undefined;
    } catch {
      return undefined;
    }
  };

  // On mount, surface any in-flight migration so the UI can offer "Finish switching".
  useEffect(() => {
    (async () => {
      const txid = await getPendingTxid();
      setHasPendingMigration(!!txid);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeAccount = (): number | null =>
    state.activeAccount === null || state.activeAccount === undefined
      ? null
      : state.activeAccount;

  /**
   * Poll until the sweep `txid` is mined (≥1 confirmation). Throws if it expires or if
   * it hasn't confirmed within the time budget (the caller can retry via finishSwitching).
   */
  const waitForSweepMined = useCallback(
    async (account: number, txid: string): Promise<void> => {
      if (!state.webWallet) throw new Error('Wallet is not ready.');
      // Read-only polling: App.tsx background sync advances scanning; we just watch
      // the history rather than calling sync() ourselves and racing it.
      for (let attempt = 0; attempt < MINED_MAX_ATTEMPTS; attempt++) {
        try {
          const history = await state.webWallet.get_transaction_history(
            account,
            50,
            0,
          );
          const txs = (history.transactions ?? []) as Array<{
            txid: string;
            status: string;
            confirmations: number;
          }>;
          const entry = txs.find((t) => t.txid === txid);
          if (entry) {
            if (entry.status === 'Expired') {
              // Clear the marker so "migrate again" starts fresh instead of
              // resuming this dead transaction forever.
              await clearPendingTxid();
              throw new Error(
                'The migration transaction expired before it was mined. Your ' +
                  'funds are still in your legacy account — please migrate again.',
              );
            }
            if (entry.status === 'Confirmed' || entry.confirmations >= 1) {
              return;
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('expired')) throw e;
          console.warn('Migration: could not read tx history while waiting', e);
        }
        await new Promise((r) => setTimeout(r, MINED_POLL_MS));
      }
      throw new Error(
        'Timed out waiting for the migration to confirm. It may still confirm on ' +
          'its own — use "Finish switching" shortly to complete the switch.',
      );
    },
    [state.webWallet],
  );

  /**
   * With the sweep mined, commit the v1 → v2 switch: confirm in the Snap, clear the
   * pending marker, then re-import onto v2 and refresh. Safe to call more than once.
   */
  const commitSwitch = useCallback(async (): Promise<void> => {
    setMigrationStatus(MigrationStatus.STAMPING);
    const stamped = (await invokeSnap({
      method: 'completeMigration',
    })) as boolean;
    if (!stamped) {
      // User declined the final confirmation. Funds are already in the portable
      // account; keep the pending marker so they can finish the switch later.
      setMigrationError(
        'Your funds are in your portable account, but the switch was not ' +
          'confirmed. Use "Finish switching" to complete it — do not migrate again.',
      );
      setMigrationStatus(MigrationStatus.ERROR);
      return;
    }

    await clearPendingTxid();

    setMigrationStatus(MigrationStatus.RESYNCING);
    await fullResync();
    await refreshSnapState();
    setMigrationStatus(MigrationStatus.DONE);
  }, [invokeSnap, fullResync, refreshSnapState]);

  // Resume an in-flight migration: wait for the recorded sweep to mine, then switch.
  const resume = useCallback(
    async (account: number, txid: string): Promise<void> => {
      setMigrationStatus(MigrationStatus.CONFIRMING);
      await waitForSweepMined(account, txid);
      await commitSwitch();
    },
    [waitForSweepMined, commitSwitch],
  );

  const finishSwitching = useCallback(async (): Promise<void> => {
    setMigrationError(null);
    const account = activeAccount();
    if (account === null) {
      setMigrationError('No active account.');
      return;
    }
    const txid = await getPendingTxid();
    if (!txid) {
      setMigrationError('There is no migration to finish.');
      return;
    }
    try {
      await resume(account, txid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Finish switching failed:', error);
      setMigrationError(message);
      setMigrationStatus(MigrationStatus.ERROR);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, state.activeAccount]);

  const migrateToPortable = async (): Promise<void> => {
    setMigrationError(null);

    if (!state.webWallet) {
      setMigrationError('Wallet is not ready. Please wait for sync to finish.');
      return;
    }
    const account = activeAccount();
    if (account === null) {
      setMigrationError('No active account to migrate.');
      return;
    }

    // Resume instead of re-sweeping: if a sweep is already in flight, finishing the
    // switch is the right action (a second sweep would fail — v1 is already empty).
    const pendingTxid = await getPendingTxid();
    if (pendingTxid) {
      try {
        await resume(account, pendingTxid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Resume migration failed:', error);
        setMigrationError(message);
        setMigrationStatus(MigrationStatus.ERROR);
      }
      return;
    }

    // Pre-flight checks for a clear reason instead of a raw Rust error. The Rust sweep
    // also enforces these, but a readable message here avoids a confusing failure.
    if (balanceLoading || isCached) {
      setMigrationError(
        'Still syncing. Wait for your balance to finish loading before migrating.',
      );
      return;
    }
    if (totalPending > 0) {
      setMigrationError(
        'You have funds still confirming. Wait until nothing is pending, then ' +
          'migrate — otherwise those funds would be left behind.',
      );
      return;
    }
    if (unshieldedBalance > 0) {
      setMigrationError(
        'You have transparent (unshielded) funds. Shield them first from the ' +
          'Account page, then migrate. The sweep moves shielded funds only, so ' +
          'transparent balance would otherwise stay in the legacy account.',
      );
      return;
    }
    if (shieldedBalance <= 0) {
      setMigrationError('There is no shielded balance to migrate.');
      return;
    }

    try {
      setMigrationStatus(MigrationStatus.PREPARING);
      // Destination: the portable (v2) account's shielded address.
      const toAddress = (await invokeSnap({
        method: 'getPortableAddress',
      })) as string;

      setMigrationStatus(MigrationStatus.CREATING);
      // Full send-max sweep: moves the entire spendable shielded balance with an
      // exact fee and no change, so nothing is stranded in the legacy account.
      const pczt = await state.webWallet.pczt_sweep(account, toAddress);

      setMigrationStatus(MigrationStatus.SIGNING);
      // Signed via the migration RPC: the Snap re-derives v2 and refuses unless every
      // output lands there. Signs with the active (v1) key that owns the spent notes.
      const pcztHexTring = Buffer.from(pczt.serialize()).toString('hex');
      const signedHex = (await invokeSnap({
        method: 'signMigration',
        params: { pcztHexTring },
      })) as string;
      const signedPczt = Pczt.from_bytes(
        new Uint8Array(Buffer.from(signedHex, 'hex')),
      );

      setMigrationStatus(MigrationStatus.PROVING);
      // Prove in a worker: the Sapling Groth16 prover uses Atomics.wait, illegal on main.
      const provedPczt = Pczt.from_bytes(
        await provePcztInWorker(signedPczt.serialize()),
      );

      setMigrationStatus(MigrationStatus.SENDING);
      const txid = await state.webWallet.pczt_send(provedPczt);
      await flushDbToStore();

      // Record the in-flight sweep BEFORE waiting, so a reload can resume it. The
      // switch is NOT committed yet — only after the sweep actually mines.
      await setPendingTxid(txid);

      // Wait for the sweep to be mined (not just broadcast) before switching. If it
      // expires or is dropped, we stay on v1 rather than switching to an empty v2.
      setMigrationStatus(MigrationStatus.CONFIRMING);
      await waitForSweepMined(account, txid);

      await commitSwitch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Migration failed:', error);
      setMigrationError(message);
      setMigrationStatus(MigrationStatus.ERROR);
    }
  };

  return {
    migrateToPortable,
    finishSwitching,
    migrationStatus,
    migrationError,
    hasPendingMigration,
  };
};
