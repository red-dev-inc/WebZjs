import { hexStringToUint8Array } from './hexStringToUint8Array';
import {
  mnemonic_from_entropy,
  seed_from_mnemonic,
} from '@zcashcommunitygrants/webzjs-keys';
import { getSnapState } from '../rpc/getSnapState';
import type { SnapState } from '../types';

/**
 * Snap key-derivation version: v1 (legacy) uses the 32-byte key directly as the seed
 * (non-standard, kept spendable); v2 (portable) routes it through BIP-39 so standard wallets reproduce it.
 */
export type DerivationVersion = 1 | 2;

export const LEGACY_DERIVATION_VERSION: DerivationVersion = 1;
export const PORTABLE_DERIVATION_VERSION: DerivationVersion = 2;

/**
 * Raw 32 bytes of deterministic entropy from MetaMask — the shared input to both
 * derivation versions (lets the v1 → v2 sweep sign with v1 while producing v2).
 */
async function getEntropyBytes(): Promise<Uint8Array> {
  const entropyNode = await snap.request({
    method: 'snap_getBip44Entropy',
    params: { coinType: 133 }, // 133 is the coin type for Zcash https://github.com/satoshilabs/slips/blob/master/slip-0044.md
  });

  if (
    typeof entropyNode !== 'object' ||
    entropyNode === null ||
    !('privateKey' in entropyNode)
  ) {
    throw new Error('Invalid entropy structure received from MetaMask');
  }

  const { privateKey } = entropyNode;
  const validatedKey = validatePrivateKey(privateKey);
  const entropy = hexStringToUint8Array(validatedKey);

  if (entropy.length !== 32) {
    throw new Error(
      `Invalid entropy length: expected 32 bytes, got ${entropy.length} bytes`,
    );
  }

  return entropy;
}

/**
 * Derive the ZIP-32 seed for `version` (defaults to legacy v1 so existing funds are
 * unaffected). Returns 32 bytes for v1, a 64-byte BIP-39 seed for v2.
 */
export async function getSeed(
  version: DerivationVersion = LEGACY_DERIVATION_VERSION,
): Promise<Uint8Array> {
  const entropy = await getEntropyBytes();

  if (version === LEGACY_DERIVATION_VERSION) {
    // v1: the 32-byte child key IS the seed (legacy behaviour, unchanged).
    return entropy;
  }

  // v2: route through standard BIP-39 → 64-byte seed (portable).
  const phrase = mnemonic_from_entropy(entropy);
  return seed_from_mnemonic(phrase);
}

/**
 * The portable (v2) BIP-39 mnemonic — the user's exportable secret phrase.
 * SECURITY: never return to the dApp; reveal only inside a Snap dialog.
 */
export async function getMnemonic(): Promise<string> {
  const entropy = await getEntropyBytes();
  return mnemonic_from_entropy(entropy);
}

/**
 * The account's derivation version from Snap state. Absent stamp → v1, so a legacy
 * account is never silently switched to v2 (which would hide its funds).
 */
export async function getActiveDerivationVersion(): Promise<DerivationVersion> {
  const state = (await getSnapState()) as SnapState | null;
  return state?.derivationVersion === PORTABLE_DERIVATION_VERSION
    ? PORTABLE_DERIVATION_VERSION
    : LEGACY_DERIVATION_VERSION;
}

function validatePrivateKey(privateKey: string | undefined): string {
  if (typeof privateKey !== 'string') {
    throw new Error('privateKey must be a string');
  }

  // Check for '0x' prefix and remove it if present
  if (privateKey.startsWith('0x') || privateKey.startsWith('0X')) {
    privateKey = privateKey.slice(2);
  }

  // Validate the length of privateKey after removing '0x' prefix
  if (privateKey.length !== 64) {
    throw new Error(
      `Invalid privateKey length: expected 64 characters without prefix, got ${privateKey.length}`,
    );
  }

  // Validate that privateKey contains only valid hex characters
  if (!/^[0-9a-fA-F]+$/.test(privateKey)) {
    throw new Error('privateKey contains invalid characters');
  }

  return privateKey;
}
