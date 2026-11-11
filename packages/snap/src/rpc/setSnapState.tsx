import { Json } from '@metamask/snaps-sdk';
import { SnapState } from 'src/types';

/**
 * Update Snap state on behalf of the dApp.
 *
 * `derivationVersion` is the consent gate for the one-way v1 → v2 switch and is NOT
 * writable through this path: whatever the caller sends for it is discarded, and the
 * stored value is always preserved. It can only change via completeMigration, which is
 * behind its own user confirmation. This keeps the trust boundary in the Snap, not the dApp.
 */
export async function setSnapState(newSnapState: SnapState): Promise<Json> {
  const existing = (await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  })) as Record<string, unknown> | null;

  const preserved: SnapState = { ...newSnapState };
  delete preserved.derivationVersion;
  if (existing && typeof existing.derivationVersion === 'number') {
    preserved.derivationVersion = existing.derivationVersion;
  }

  const state = (await snap.request({
    method: 'snap_manageState',
    params: {
      operation: 'update',
      newState: preserved,
    },
  })) as unknown as Json;

  return state;
}
