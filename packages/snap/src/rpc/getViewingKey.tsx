import { UnifiedSpendingKey } from '@zcashcommunitygrants/webzjs-keys';
import { getSeed, getActiveDerivationVersion } from '../utils/getSeed';
import { Box, Copyable, Divider, Heading, Text } from '@metamask/snaps-sdk/jsx';
import { NETWORK } from '../config';

type Network = 'main' | 'test';

export async function getViewingKey(origin: string) {
  // Hardcoded, not caller-supplied: request.params must not choose network/account.
  const network: Network = NETWORK;
  const accountIndex = 0;

  // Retrieve the seed for this account's active derivation version
  const seed = await getSeed(await getActiveDerivationVersion());

  // Generate the UnifiedSpendingKey and obtain the Viewing Key
  const spendingKey = new UnifiedSpendingKey(network, seed, accountIndex);
  const viewingKey = spendingKey.to_unified_full_viewing_key().encode(network);

  const dialogApproved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>Reveal Viewing Key to the {origin}</Heading>
          <Divider />
          <Text>Web wallet {origin} needs access to the Viewing Key, approve this dialog to give permission. The Web Wallet account is serialized and stored only locally in your browser.</Text>
          <Text>Approving gives {origin} your Zcash viewing key, a permanent window into this wallet. It cannot move your money, but whoever holds it can see everything this wallet receives and sends, forever. Do not approve unless you trust this site with this wallet's full financial history.</Text>
          <Divider />
          <Copyable value={viewingKey} />
        </Box>
      ),
    },
  });

  // Surface the real outcome instead of masking a rejection as a generation failure.
  if (!dialogApproved) {
    throw new Error('User rejected the viewing key request');
  }

  return viewingKey;
}
