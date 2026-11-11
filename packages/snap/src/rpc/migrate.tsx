import { UnifiedSpendingKey } from '@zcashcommunitygrants/webzjs-keys';
import { getSeed, PORTABLE_DERIVATION_VERSION } from '../utils/getSeed';
import { Box, Bold, Divider, Heading, Text } from '@metamask/snaps-sdk/jsx';
import { NETWORK } from '../config';

type Network = 'main' | 'test';

/**
 * Default unified (shielded) address of the portable (v2) account — the destination
 * for a v1 → v2 migration sweep. Not secret, but it is a stable identifier for this
 * MetaMask user, so (like every other identity-revealing RPC here) it is gated by a
 * user confirmation that names the requesting origin.
 */
export async function getPortableAddress(origin: string): Promise<string> {
  // Hardcoded, not caller-supplied: request.params must not choose network/account.
  const network: Network = NETWORK;
  const accountIndex = 0;
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>Share your portable Zcash address?</Heading>
          <Divider />
          <Text>
            <Bold>{origin}</Bold> is requesting the receiving address of your
            portable Zcash account. This is where your funds move during
            migration. It is not secret, but only approve if you trust this site.
          </Text>
        </Box>
      ),
    },
  });

  if (!approved) {
    throw new Error('User rejected');
  }

  const seed = await getSeed(PORTABLE_DERIVATION_VERSION);
  const spendingKey = new UnifiedSpendingKey(network, seed, accountIndex);
  return spendingKey
    .to_unified_full_viewing_key()
    .get_unified_address(network);
}

/**
 * Stamp `derivationVersion: 2` into Snap state to commit the portable switch. Gated by a
 * confirmation; call only AFTER the sweep is broadcast, else v2 shows empty while funds sit in v1.
 */
export async function completeMigration(origin: string): Promise<boolean> {
  const confirmed = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>Switch to your portable Zcash account?</Heading>
          <Divider />
          <Text>
            Requested by <Bold>{origin}</Bold>.
          </Text>
          <Text>
            Confirm only after your funds have finished moving to the portable
            account. From now on this wallet will use the portable account, whose
            recovery phrase you can export.
          </Text>
          <Text>
            <Bold>Do not confirm if the migration transaction has not been sent.</Bold>
          </Text>
        </Box>
      ),
    },
  });

  if (!confirmed) {
    return false;
  }

  const existing = (await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  })) as Record<string, unknown> | null;

  await snap.request({
    method: 'snap_manageState',
    params: {
      operation: 'update',
      newState: {
        ...existing,
        derivationVersion: PORTABLE_DERIVATION_VERSION,
      },
    },
  });

  return true;
}
