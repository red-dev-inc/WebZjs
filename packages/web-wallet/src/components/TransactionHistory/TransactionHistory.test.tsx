import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TransactionHistory, { OLDER_HISTORY_HINT } from './TransactionHistory';
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

const sample: TransactionHistoryEntry[] = [
  base,
  { ...base, txid: 'cd'.repeat(32), tx_type: 'Received', value: 500_000, recipients: [] },
  { ...base, txid: 'ef'.repeat(32), tx_type: 'Shielded', value: 200_000, pool: 'mixed', recipients: [] },
];

// Reassigned per test so the empty state can be exercised with the same mock.
let transactions: TransactionHistoryEntry[] = sample;

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

beforeEach(() => {
  transactions = sample;
});

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

describe('TransactionHistory older-history hint', () => {
  it('points to Full Resync on the Account Summary tab under the list', () => {
    render(
      <MemoryRouter>
        <TransactionHistory />
      </MemoryRouter>,
    );
    expect(screen.getByText(new RegExp(OLDER_HISTORY_HINT))).toBeInTheDocument();
    expect(screen.getByText('Account Summary')).toHaveAttribute('href', '/dashboard/account-summary');
  });

  it('shows the hint in the empty state as well', () => {
    transactions = [];
    render(
      <MemoryRouter>
        <TransactionHistory />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No transactions found/)).toBeInTheDocument();
    expect(screen.getByText('Account Summary')).toHaveAttribute('href', '/dashboard/account-summary');
  });
});
