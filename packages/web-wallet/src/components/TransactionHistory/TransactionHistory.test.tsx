import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TransactionHistory from './TransactionHistory';
import type { TransactionHistoryEntry } from '../../types/transaction';

const base: TransactionHistoryEntry = {
  txid: 'ab'.repeat(32),
  tx_type: 'Sent',
  value: -1_000_000,
  fee: null,
  block_height: 3_500_000,
  confirmations: 3,
  status: 'Confirmed',
  memo: null,
  timestamp: 1_760_000_000,
  pool: 'orchard',
  recipients: ['u1recipientaddressthatislongenoughtobeshortened'],
};

const transactions: TransactionHistoryEntry[] = [
  base,
  { ...base, txid: 'cd'.repeat(32), tx_type: 'Received', value: 500_000, recipients: [] },
  { ...base, txid: 'ef'.repeat(32), tx_type: 'Shielded', value: 200_000, pool: 'mixed', recipients: [] },
];

vi.mock('../../hooks/useTransactionHistory', () => ({
  useTransactionHistory: () => ({
    transactions,
    loading: false,
    error: null,
    totalCount: transactions.length,
    hasMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('TransactionHistory repeat links', () => {
  it('offers Send again for a sent transaction, with the recipient in the link state', () => {
    render(
      <MemoryRouter>
        <TransactionHistory />
      </MemoryRouter>,
    );
    const sendAgain = screen.getByText('Send again');
    expect(sendAgain).toHaveAttribute('href', '/dashboard/transfer-balance');
    expect(screen.getByText(/^To: u1recipient/)).toBeInTheDocument();
  });

  it('offers Shield again for a shielding transaction and nothing for a received one', () => {
    render(
      <MemoryRouter>
        <TransactionHistory />
      </MemoryRouter>,
    );
    expect(screen.getByText('Shield again')).toHaveAttribute('href', '/dashboard/shield-balance');
    expect(screen.getAllByText(/again$/)).toHaveLength(2);
  });
});
