/** Options for a full resync requested from the UI. */
export interface FullResyncOptions {
  /** Aborting before the resync starts drops it from the sync queue; it has no effect once started. */
  signal?: AbortSignal;
  /** Called when the resync starts, once any sync queued ahead of it has finished. */
  onStart?: () => void;
}

// The full resync in flight, if any, so a remounted card shows it instead of offering another.
let pending: Promise<void> | null = null;

export function pendingFullResync(): Promise<void> | null {
  return pending;
}

/** Records `run` as the full resync in flight until it settles. */
export function trackFullResync(run: Promise<void>): Promise<void> {
  const tracked: Promise<void> = run
    .catch(() => undefined)
    .finally(() => {
      if (pending === tracked) pending = null;
    });
  pending = tracked;
  return tracked;
}
