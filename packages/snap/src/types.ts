import type { Json } from '@metamask/snaps-sdk';

export type SetBirthdayBlockParams = { latestBlock: number };

export type SignPcztParams = {
  pcztHexTring: string;
  signDetails: {
    recipient: string;
    amount: string;
  };
};

/**
 * Cached balance stored in snap state for recovery after cookie/IndexedDB clears.
 * All fields are Json-compatible (number extends Json).
 */
export type LastKnownBalance = {
  shielded: number;     // sapling + orchard (in zats)
  unshielded: number;   // transparent (in zats)
  timestamp: number;    // When last updated (ms)
};

/**
 * Snap persistent state stored via snap_manageState.
 * Must be Json-serializable (no undefined values).
 * Optional fields use `| null` instead of `?` to maintain Json compatibility.
 */
export type SnapState = {
  webWalletSyncStartBlock: string;
  lastKnownBalance: LastKnownBalance | null;
  hasPendingTx: boolean | null;
  // Key-derivation version for this account (see utils/getSeed.ts).
  // Absent → legacy v1 (never silently switch an existing account).
  derivationVersion?: number;
  // Txid of an in-flight migration sweep (durable mirror of the dApp's IndexedDB marker).
  pendingMigrationTxid?: string | null;
} & Record<string, Json>;
