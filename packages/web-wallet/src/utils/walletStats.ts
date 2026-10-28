import type { TransactionHistoryEntry } from '../types/transaction';

/** Figures derived from the account's whole transaction history. */
export interface ActivityStats {
  /** Confirmed or pending transactions, by kind */
  sentCount: number;
  receivedCount: number;
  shieldedCount: number;
  /** Zatoshis that left the wallet in Sent transactions (fees included) */
  totalSent: number;
  /** Zatoshis that arrived in Received transactions */
  totalReceived: number;
  /** Zatoshis moved into shielded pools by Shielded transactions */
  totalShielded: number;
  /** Unix seconds of the oldest and newest mined transactions */
  firstActivity: number | null;
  lastActivity: number | null;
  /** Transactions that carried a memo */
  memoCount: number;
}

export const EMPTY_ACTIVITY: ActivityStats = {
  sentCount: 0,
  receivedCount: 0,
  shieldedCount: 0,
  totalSent: 0,
  totalReceived: 0,
  totalShielded: 0,
  firstActivity: null,
  lastActivity: null,
  memoCount: 0,
};

export function computeActivityStats(transactions: TransactionHistoryEntry[]): ActivityStats {
  const stats: ActivityStats = { ...EMPTY_ACTIVITY };
  for (const tx of transactions) {
    if (tx.status === 'Expired') continue;
    switch (tx.tx_type) {
      case 'Sent':
        stats.sentCount += 1;
        stats.totalSent += Math.abs(tx.value);
        break;
      case 'Received':
        stats.receivedCount += 1;
        stats.totalReceived += tx.value;
        break;
      case 'Shielded':
        stats.shieldedCount += 1;
        stats.totalShielded += Math.abs(tx.value);
        break;
    }
    if (tx.memo) stats.memoCount += 1;
    if (tx.timestamp) {
      stats.firstActivity =
        stats.firstActivity === null ? tx.timestamp : Math.min(stats.firstActivity, tx.timestamp);
      stats.lastActivity =
        stats.lastActivity === null ? tx.timestamp : Math.max(stats.lastActivity, tx.timestamp);
    }
  }
  return stats;
}
