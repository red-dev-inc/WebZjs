import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { BlockHeightCard } from './BlockHeightCard';
import { WebZjsState } from 'src/context/WebzjsContext';
import { FullResyncOptions } from 'src/hooks/fullResyncQueue';

const baseState: WebZjsState = {
  webWallet: null,
  installedSnap: null,
  error: null,
  summary: undefined,
  chainHeight: 3_500_000n,
  activeAccount: 0,
  syncInProgress: false,
  loading: false,
  initialized: true,
};

function openForm() {
  fireEvent.click(screen.getByText('Full Resync'));
  return screen.getByPlaceholderText('e.g. 2674500') as HTMLInputElement;
}

describe('BlockHeightCard full resync form', () => {
  it('keeps the form open while a background sync is in progress', () => {
    const onFullResync = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <BlockHeightCard state={baseState} onFullResync={onFullResync} />,
    );
    const input = openForm();
    fireEvent.change(input, { target: { value: '2600000' } });

    rerender(
      <BlockHeightCard state={{ ...baseState, syncInProgress: true }} onFullResync={onFullResync} />,
    );

    expect(screen.getByText('Sync in progress...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. 2674500')).toHaveValue(2600000);
    expect(screen.getByText('Confirm Resync')).toBeEnabled();
  });

  it('disables Confirm and Cancel once the resync runs, then closes the form when it settles', async () => {
    let finish!: () => void;
    const onFullResync = vi.fn(
      (_birthday?: number, options?: FullResyncOptions) =>
        new Promise<void>((resolve) => {
          finish = resolve;
          options?.onStart?.();
        }),
    );
    render(<BlockHeightCard state={baseState} onFullResync={onFullResync} />);
    const input = openForm();
    fireEvent.change(input, { target: { value: '2600000' } });
    await act(async () => { fireEvent.click(screen.getByText('Confirm Resync')); });

    expect(onFullResync).toHaveBeenCalledWith(
      2600000,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText('Resyncing…')).toBeDisabled();
    expect(screen.getByText('Cancel')).toBeDisabled();

    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByText('Full Resync')).toBeInTheDocument());
  });

  it('can be cancelled while the resync is still waiting for another sync to finish', async () => {
    let signal: AbortSignal | undefined;
    const onFullResync = vi.fn(
      (_birthday?: number, options?: FullResyncOptions) =>
        new Promise<void>(() => {
          signal = options?.signal;
        }),
    );
    render(<BlockHeightCard state={baseState} onFullResync={onFullResync} />);
    openForm();
    await act(async () => { fireEvent.click(screen.getByText('Confirm Resync')); });

    expect(screen.getByText('Waiting for the current sync…')).toBeDisabled();
    expect(screen.getByText('Cancel')).toBeEnabled();

    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText('Full Resync')).toBeInTheDocument();
  });

  it('rejects a birthday above the chain height without starting a resync', () => {
    const onFullResync = vi.fn().mockResolvedValue(undefined);
    render(<BlockHeightCard state={baseState} onFullResync={onFullResync} />);
    const input = openForm();
    fireEvent.change(input, { target: { value: '30000000' } });
    fireEvent.click(screen.getByText('Confirm Resync'));

    expect(onFullResync).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('above the chain height (3500000)');
    expect(screen.getByPlaceholderText('e.g. 2674500')).toBeInTheDocument();
  });

  it('rejects a birthday below Sapling activation', () => {
    const onFullResync = vi.fn().mockResolvedValue(undefined);
    render(<BlockHeightCard state={baseState} onFullResync={onFullResync} />);
    const input = openForm();
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.click(screen.getByText('Confirm Resync'));

    expect(onFullResync).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('at least 419200');
  });

  it('passes undefined when the birthday field is left empty', async () => {
    const onFullResync = vi.fn().mockResolvedValue(undefined);
    render(<BlockHeightCard state={baseState} onFullResync={onFullResync} />);
    openForm();
    await act(async () => { fireEvent.click(screen.getByText('Confirm Resync')); });

    expect(onFullResync).toHaveBeenCalledWith(undefined, expect.anything());
  });
});
