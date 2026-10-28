import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalletStatsCard } from './WalletStatsCard';
import { computeActivityStats, EMPTY_ACTIVITY } from '../../utils/walletStats';
import type { TransactionHistoryEntry } from '../../types/transaction';

const tx = (over: Partial<TransactionHistoryEntry>): TransactionHistoryEntry => ({
  txid: 'ab'.repeat(32),
  tx_type: 'Received',
  value: 100_000_000,
  fee: null,
  block_height: 3_500_000,
  confirmations: 1,
  status: 'Confirmed',
  memo: null,
  timestamp: 1_700_000_000,
  pool: 'orchard',
  ...over,
} as TransactionHistoryEntry);

describe('computeActivityStats', () => {
  it('counts and sums by kind, skips expired, and tracks first and last activity', () => {
    const stats = computeActivityStats([
      tx({ value: 100_000_000, timestamp: 1_700_000_000, memo: 'hi' }),
      tx({ tx_type: 'Sent', value: -25_000_000, timestamp: 1_710_000_000 }),
      tx({ tx_type: 'Shielded', value: 5_000_000, timestamp: 1_705_000_000 }),
      tx({ tx_type: 'Sent', value: -1_000_000, status: 'Expired', timestamp: 1_720_000_000 }),
      tx({ tx_type: 'Received', value: 1, timestamp: null, status: 'Pending' }),
    ]);
    expect(stats).toEqual({
      sentCount: 1,
      receivedCount: 2,
      shieldedCount: 1,
      totalSent: 25_000_000,
      totalReceived: 100_000_001,
      totalShielded: 5_000_000,
      firstActivity: 1_700_000_000,
      lastActivity: 1_710_000_000,
      memoCount: 1,
    });
  });

  it('returns the empty figures for no history', () => {
    expect(computeActivityStats([])).toEqual(EMPTY_ACTIVITY);
  });
});

describe('WalletStatsCard', () => {
  it('shows the shielded share, pool balances, counts, and sync distance', () => {
    render(
      <WalletStatsCard
        pools={{ transparent: 25_000_000, sapling: 0, orchard: 75_000_000, ironwood: 0 }}
        activity={{ ...EMPTY_ACTIVITY, sentCount: 2, receivedCount: 3, totalSent: 50_000_000, memoCount: 1 }}
        chainHeight={3_500_010}
        syncedHeight={3_500_000}
      />,
    );
    expect(screen.getByText('75% shielded')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1 with memos')).toBeInTheDocument();
    expect(screen.getByText('10 behind')).toBeInTheDocument();
  });

  it('hides lifetime totals until resynced wallets can classify their own spends', () => {
    render(
      <WalletStatsCard
        pools={{ transparent: 0, sapling: 0, orchard: 0, ironwood: 0 }}
        activity={{ ...EMPTY_ACTIVITY, sentCount: 1, totalSent: 25_000_000, totalReceived: 1 }}
        chainHeight={100}
        syncedHeight={100}
      />,
    );
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    expect(screen.queryByText('Received')).not.toBeInTheDocument();
    expect(screen.queryByText('Shielded')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    expect(screen.queryByText(/ in · /)).not.toBeInTheDocument();
  });

  it('reads "At chain tip" when synced and "None yet" without activity', () => {
    render(
      <WalletStatsCard
        pools={{ transparent: 0, sapling: 0, orchard: 0, ironwood: 0 }}
        activity={EMPTY_ACTIVITY}
        chainHeight={100}
        syncedHeight={100}
      />,
    );
    expect(screen.getByText('At chain tip')).toBeInTheDocument();
    expect(screen.getAllByText('None yet')).toHaveLength(2);
    expect(screen.getByText('0% shielded')).toBeInTheDocument();
  });
});
