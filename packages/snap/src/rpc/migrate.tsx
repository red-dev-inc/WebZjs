import { UnifiedSpendingKey } from '@zcashcommunitygrants/webzjs-keys';
import { getSeed, PORTABLE_DERIVATION_VERSION } from '../utils/getSeed';
import { Box, Bold, Divider, Heading, Text } from '@metamask/snaps-sdk/jsx';
import { NETWORK } from '../config';

type Network = 'main' | 'test';

/**
 * Default unified (shielded) address of the portable (v2) account — the destination
 * for a v1 → v2 migration sweep. Public, so safe to return to the dApp.
 */
export async function getPortableAddress(
  network: Network = NETWORK,
  accountIndex: number = 0,
): Promise<string> {
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
export async function completeMigration(): Promise<boolean> {
  const confirmed = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>Switch to your portable Zcash account?</Heading>
          <Divider />
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
