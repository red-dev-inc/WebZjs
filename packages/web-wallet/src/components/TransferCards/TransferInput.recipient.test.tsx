import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  TransferInput,
  KNOWN_RECIPIENT_HINT,
  NEW_RECIPIENT_HINT,
} from './TransferInput';

const hasSentTo = vi.fn();
const mockState = { webWallet: { has_sent_to: hasSentTo }, activeAccount: 0 };

vi.mock('../../context/WebzjsContext', () => ({
  useWebZjsContext: () => ({ state: mockState, dispatch: vi.fn() }),
}));

vi.mock('../../hooks/useBalance', () => ({
  default: () => ({ spendableBalance: 100_000_000 }),
}));

const KNOWN = 'u1knownaddress';
const NEW = 'u1newaddress';

function renderInput(recipient: string, prefilledRecipient = '') {
  const nextStep = vi.fn();
  render(
    <TransferInput
      formData={{ recipient, amount: '0.1' }}
      prefilledRecipient={prefilledRecipient}
      handleChange={() => () => undefined}
      nextStep={nextStep}
    />,
  );
  return nextStep;
}

describe('TransferInput recipient check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hasSentTo.mockReset();
  });

  it('shows a prefilled recipient as known without asking the wallet', () => {
    renderInput(KNOWN, KNOWN);
    expect(screen.getByText(KNOWN_RECIPIENT_HINT)).toBeInTheDocument();
    expect(hasSentTo).not.toHaveBeenCalled();
  });

  it('cautions about an address the wallet has never sent to', async () => {
    hasSentTo.mockResolvedValue(false);
    renderInput(NEW);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(hasSentTo).toHaveBeenCalledWith(0, NEW);
    expect(screen.getByText(NEW_RECIPIENT_HINT)).toBeInTheDocument();
  });

  it('marks an address the wallet has sent to before as known', async () => {
    hasSentTo.mockResolvedValue(true);
    renderInput(KNOWN);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(KNOWN_RECIPIENT_HINT)).toBeInTheDocument();
  });

  it('blocks Continue when the wallet rejects the address', async () => {
    hasSentTo.mockRejectedValue(new Error('Error attempting to decode address'));
    const nextStep = renderInput('not an address');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('Please enter a valid Zcash address')).toBeInTheDocument());
    expect(nextStep).not.toHaveBeenCalled();
  });

  it('treats a wallet failure that is not about the address as a new recipient', async () => {
    hasSentTo.mockRejectedValue(new Error('wallet is busy'));
    const nextStep = renderInput(NEW);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText(NEW_RECIPIENT_HINT)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    vi.useRealTimers();
    await waitFor(() => expect(nextStep).toHaveBeenCalled());
  });

  it('still lets a never-sent-to address continue', async () => {
    hasSentTo.mockResolvedValue(false);
    const nextStep = renderInput(NEW);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });
    vi.useRealTimers();
    await waitFor(() => expect(nextStep).toHaveBeenCalled());
  });
});
