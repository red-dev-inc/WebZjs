/** Options for a full resync requested from the UI. */
export interface FullResyncOptions {
  /**
   * Aborting before the resync starts drops it from the sync queue. Once started, the resync
   * stops at the next step boundary, drops its checkpoint and leaves the current wallet in place.
   */
  signal?: AbortSignal;
  /** Called when the resync starts, once any sync queued ahead of it has finished. */
  onStart?: () => void;
  /** Continue from the checkpoint of an earlier resync instead of starting from the birthday. */
  resume?: boolean;
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
