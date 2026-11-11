import {
  Bold,
  Box,
  Copyable,
  Divider,
  Heading,
  Text,
} from '@metamask/snaps-sdk/jsx';
import {
  SeedFingerprint,
  UnifiedSpendingKey,
  pczt_describe,
  pczt_validate,
  pczt_sign,
  Pczt,
} from '@zcashcommunitygrants/webzjs-keys';
import {
  getSeed,
  getActiveDerivationVersion,
  PORTABLE_DERIVATION_VERSION,
} from '../utils/getSeed';
import { NETWORK } from '../config';

const ZATS_PER_ZEC = 100_000_000n;

export type SignMigrationParams = {
  pcztHexTring: string;
};

/** A single output recovered from a PCZT by `pczt_describe`. */
type PcztOutputSummary = {
  pool: string;
  recipient: string | null;
  value: number | bigint;
  memo: string | null;
  is_change: boolean;
  is_ours: boolean;
  verified: boolean;
};

type PcztSummary = {
  network: string;
  outputs: PcztOutputSummary[];
  total_in: number | bigint;
  total_out: number | bigint;
  fee: number | bigint;
  migration: unknown;
};

function zatsToZec(zats: number | bigint): string {
  const z = BigInt(zats);
  const frac = (z % ZATS_PER_ZEC).toString().padStart(8, '0');
  return `${z / ZATS_PER_ZEC}.${frac}`;
}

/**
 * Sign the one-time v1 → v2 migration sweep. The Snap re-derives v2 itself and refuses
 * unless every output is change or a payment to v2 — the dApp cannot swap the destination.
 */
export async function signMigration(
  { pcztHexTring }: SignMigrationParams,
  origin: string,
): Promise<string> {
  // Odd-length hex would be silently truncated by Buffer.from.
  if (!/^[0-9a-fA-F]+$/.test(pcztHexTring) || pcztHexTring.length % 2 !== 0) {
    throw new Error('pcztHexTring must be valid, even-length hex');
  }
  const pczt = Pczt.from_bytes(new Uint8Array(Buffer.from(pcztHexTring, 'hex')));

  // Signing key = the account that owns the spent notes (pre-switch this is v1).
  const activeVersion = await getActiveDerivationVersion();
  const seedActive = await getSeed(activeVersion);
  const uskActive = new UnifiedSpendingKey(NETWORK, seedActive, 0);
  const ufvkActive = uskActive.to_unified_full_viewing_key();
  const seedFp = new SeedFingerprint(seedActive);

  // Portable (v2) account — the only permitted destination for the sweep.
  const seedV2 = await getSeed(PORTABLE_DERIVATION_VERSION);
  const ufvkV2 = new UnifiedSpendingKey(NETWORK, seedV2, 0)
    .to_unified_full_viewing_key();

  // --- Layer B: hard gate under the signing key (spends are ours, value
  // balances, fee is sane). Same protection the ordinary signing path applies.
  try {
    pczt_validate(NETWORK, pczt, ufvkActive);
  } catch (e) {
    throw new Error(
      `This migration failed safety validation and will not be signed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // Describe the SAME PCZT under both keys; the deterministic walk lines up outputs by
  // index: `active` flags change to the signer, `v2` flags payments to the portable account.
  let active: PcztSummary;
  let v2: PcztSummary;
  try {
    active = pczt_describe(NETWORK, pczt, ufvkActive) as PcztSummary;
    v2 = pczt_describe(NETWORK, pczt, ufvkV2) as PcztSummary;
  } catch (e) {
    throw new Error(
      `Unable to read the migration transaction: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (active.outputs.length !== v2.outputs.length) {
    throw new Error('Migration PCZT inspection was inconsistent; refusing to sign.');
  }

  // Enforce: every output is either change to the signing account, or a payment to
  // the portable (v2) account. Anything else is a swapped destination — reject.
  let sweptToPortable = 0n;
  for (let i = 0; i < active.outputs.length; i++) {
    const out = active.outputs[i];
    const v2Out = v2.outputs[i];
    if (!out || !v2Out) {
      throw new Error('Migration PCZT inspection was inconsistent; refusing to sign.');
    }
    const isChangeToSelf = out.is_change;
    const isToPortable = v2Out.is_ours;
    if (isChangeToSelf) continue;
    if (isToPortable) {
      sweptToPortable += BigInt(out.value);
      continue;
    }
    throw new Error(
      'Refusing to sign: this migration pays an address that is NOT your ' +
        'portable account. The destination may have been tampered with.',
    );
  }
  if (sweptToPortable === 0n) {
    throw new Error('Refusing to sign: this migration moves nothing to your portable account.');
  }

  const content = (
    <Box>
      <Heading>Move funds to your portable Zcash account</Heading>
      <Text>Origin: {origin}</Text>
      <Divider />
      <Text>
        ✓ <Bold>Destination verified as your own portable account.</Bold> The Snap
        derived it and confirmed every payment lands there.
      </Text>
      <Text>
        Moving <Bold>{`${zatsToZec(sweptToPortable)} ZEC`}</Bold> · Fee:{' '}
        <Bold>{`${zatsToZec(active.fee)} ZEC`}</Bold>
      </Text>
      <Text>
        After you approve, your browser may freeze for a few minutes while the
        transaction is proved. This is normal — keep the tab open until it finishes.
      </Text>
      <Divider />
      <Text>Raw PCZT</Text>
      <Copyable value={pcztHexTring} />
    </Box>
  );

  const approved = await snap.request({
    method: 'snap_dialog',
    params: { type: 'confirmation', content },
  });

  if (!approved) {
    throw new Error('User rejected');
  }

  const pcztSigned = await pczt_sign(NETWORK, pczt, uskActive, seedFp);
  return Buffer.from(pcztSigned.serialize()).toString('hex');
}
