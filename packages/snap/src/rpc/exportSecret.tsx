import { UnifiedSpendingKey } from '@zcashcommunitygrants/webzjs-keys';
import {
  getMnemonic,
  getSeed,
  getActiveDerivationVersion,
  PORTABLE_DERIVATION_VERSION,
  LEGACY_DERIVATION_VERSION,
} from '../utils/getSeed';
import {
  Box,
  Bold,
  Copyable,
  Divider,
  Heading,
  Text,
} from '@metamask/snaps-sdk/jsx';
import { NETWORK } from '../config';

type Network = 'main' | 'test';

/**
 * Reveal the account's portable (v2) BIP-39 phrase + viewing key for import into a
 * standard Zcash wallet. SECURITY: shown only in the Snap dialog, never returned to the dApp.
 */
export async function exportZcashSecret(
  network: Network = NETWORK,
  accountIndex: number = 0,
): Promise<boolean> {
  // 1. Confirm-to-reveal. No secret is derived or shown until the user approves.
  const confirmed = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>Reveal your Zcash recovery phrase?</Heading>
          <Divider />
          <Text>
            You are about to reveal the secret recovery phrase for your Zcash
            wallet. Make sure no one can see your screen.
          </Text>
          <Text>
            <Bold>
              This is NOT your MetaMask Secret Recovery Phrase.
            </Bold>{' '}
            It is a separate phrase for your Zcash wallet only — back it up
            separately.
          </Text>
          <Text>
            Anyone with this phrase can spend your Zcash funds. Never share it.
            Zcash Community Grants will never ask you for it.
          </Text>
        </Box>
      ),
    },
  });

  if (!confirmed) {
    // User declined — nothing was derived or released.
    return false;
  }

  // 2. Derive the portable (v2) secret. Export always reveals the portable
  // account, since the legacy (v1) account cannot be reproduced from a mnemonic.
  const mnemonic = await getMnemonic();
  const seed = await getSeed(PORTABLE_DERIVATION_VERSION);
  const spendingKey = new UnifiedSpendingKey(network, seed, accountIndex);
  const viewingKey = spendingKey.to_unified_full_viewing_key().encode(network);

  // If the account hasn't migrated yet, its funds still live in the legacy
  // account — warn so the user doesn't think an empty import means lost money.
  const onLegacy =
    (await getActiveDerivationVersion()) === LEGACY_DERIVATION_VERSION;

  // 3. Reveal inside the Snap dialog. The phrase is blurred until tapped.
  await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'alert',
      content: (
        <Box>
          <Heading>Your Zcash wallet recovery phrase</Heading>
          <Text>
            Import these 24 words into another Zcash wallet (e.g. Zkool or Zodl)
            to access this wallet there. Keep them secret and safe.
          </Text>
          <Copyable value={mnemonic} sensitive={true} />
          {onLegacy ? (
            <Text>
              <Bold>Note:</Bold> this is your portable Zcash account. If you have
              existing funds, they are still in a separate legacy account and
              must be migrated to this one before they appear here.
            </Text>
          ) : (
            <Text> </Text>
          )}
          <Divider />
          <Text>
            Viewing key (watch-only — lets another wallet see this account's
            balance, but not spend):
          </Text>
          <Copyable value={viewingKey} />
        </Box>
      ),
    },
  });

  // Never return the secret to the dApp — only an acknowledgement.
  return true;
}
