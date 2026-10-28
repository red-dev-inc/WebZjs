import { useEffect, useRef, useState } from 'react';
import { useWebZjsContext } from '../context/WebzjsContext';
import type { TransactionHistoryResponse } from '../types/transaction';
import { ActivityStats, EMPTY_ACTIVITY, computeActivityStats } from '../utils/walletStats';

/** Enough to cover any wallet this app will see; the Rust side builds the full list regardless. */
const ALL_TRANSACTIONS = 100_000;

interface UseWalletStatsResult {
  activity: ActivityStats;
  loading: boolean;
}

/**
 * Activity figures for the active account, recomputed whenever the scanned height moves.
 * Reads the wallet's own history only; nothing leaves the browser.
 */
export function useWalletStats(): UseWalletStatsResult {
  const { state } = useWebZjsContext();
  const [activity, setActivity] = useState<ActivityStats>(EMPTY_ACTIVITY);
  const [loading, setLoading] = useState(false);
  const lastHeightRef = useRef<number | undefined>(undefined);

  const scannedHeight = state.summary?.fully_scanned_height;
  const { webWallet, activeAccount, syncInProgress } = state;

  useEffect(() => {
    if (!webWallet || activeAccount === null || activeAccount === undefined) return;
    if (syncInProgress) return;
    if (scannedHeight === lastHeightRef.current) return;

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const response: TransactionHistoryResponse = await webWallet.get_transaction_history(
          activeAccount,
          ALL_TRANSACTIONS,
          0,
        );
        if (!cancelled) {
          // Recorded only once a read completes, so a read cancelled by a sync that started
          // mid-flight is retried when the sync ends, even if the height did not move.
          lastHeightRef.current = scannedHeight;
          setActivity(computeActivityStats(response.transactions));
        }
      } catch (err) {
        console.warn('Wallet stats: could not read transaction history', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [webWallet, activeAccount, scannedHeight, syncInProgress]);

  return { activity, loading };
}
