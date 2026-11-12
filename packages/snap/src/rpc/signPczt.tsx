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
  decode_address_receivers,
  Pczt,
} from '@zcashcommunitygrants/webzjs-keys';
import { getSeed, getActiveDerivationVersion } from '../utils/getSeed';
import { SignPcztParams } from 'src/types';
import { NETWORK } from '../config';

const ZATS_PER_ZEC = 100_000_000n;

/**
 * A single output recovered from a PCZT by `pczt_describe`. Mirrors
 * `PcztOutputSummary` in `crates/webzjs-common/src/pczt_summary.rs`.
 */
type PcztOutputSummary = {
  pool: string;
  recipient: string | null;
  value: number | bigint;
  memo: string | null;
  is_change: boolean;
  is_ours: boolean;
  verified: boolean;
};

/**
 * NU6.3 Path-A migration recognition. Mirrors `MigrationSummary` in
 * `crates/webzjs-common/src/pczt_summary.rs`. Present when the PCZT moves value
 * into the Ironwood pool.
 */
type MigrationSummary = {
  amount: number | bigint;
  to_self: boolean;
  is_clean_path_a: boolean;
};

/** Trusted-display summary recovered from a PCZT. Mirrors `PcztSummary`. */
type PcztSummary = {
  network: string;
  outputs: PcztOutputSummary[];
  total_in: number | bigint;
  total_out: number | bigint;
  fee: number | bigint;
  migration: MigrationSummary | null;
};

/** Parse a ZEC decimal string into zatoshis, without floating-point error. */
function zecToZats(zec: string): bigint {
  const [whole, fracRaw = ''] = zec.trim().split('.');
  // ZEC has exactly 8 decimal places (zatoshis). Reject extra precision rather
  // than silently truncating it — a truncated claim could otherwise match the
  // verified amount and suppress the mismatch warning. See SECURITY_REPORT.md
  // Finding 3.
  if (fracRaw.length > 8) {
    throw new Error(`amount has more than 8 decimal places: ${zec}`);
  }
  const frac = (fracRaw + '00000000').slice(0, 8);
  return BigInt(whole || '0') * ZATS_PER_ZEC + BigInt(frac || '0');
}

/** Format zatoshis as a ZEC string with 8 decimal places. */
function zatsToZec(zats: number | bigint): string {
  const z = BigInt(zats);
  const frac = (z % ZATS_PER_ZEC).toString().padStart(8, '0');
  return `${z / ZATS_PER_ZEC}.${frac}`;
}

/** Abbreviate a long address for display. */
function shortAddr(addr: string | null): string {
  if (!addr) return '(unrecoverable — refused)';
  return addr.length > 32 ? `${addr.slice(0, 18)}…${addr.slice(-10)}` : addr;
}

export async function signPczt(
  { pcztHexTring, signDetails }: SignPcztParams,
  origin: string,
): Promise<string> {
  // Odd-length hex would be silently truncated by Buffer.from.
  if (!/^[0-9a-fA-F]+$/.test(pcztHexTring) || pcztHexTring.length % 2 !== 0) {
    throw new Error('pcztHexTring must be valid, even-length hex');
  }
  const pcztUint8Array = new Uint8Array(Buffer.from(pcztHexTring, 'hex'));
  const pczt = Pczt.from_bytes(pcztUint8Array);

  const seed = await getSeed(await getActiveDerivationVersion());
  const spendingKey = new UnifiedSpendingKey(NETWORK, seed, 0);
  const seedFp = new SeedFingerprint(seed);
  const ufvk = spendingKey.to_unified_full_viewing_key();

  // --- Layer B: hard gate. Refuse structurally-unsafe PCZTs before prompting.
  // (`pczt_describe` / `pczt_validate` borrow the PCZT; `pczt_sign` consumes it,
  // so both inspections must run before signing.)
  try {
    pczt_validate(NETWORK, pczt, ufvk);
  } catch (e) {
    throw new Error(
      `This transaction failed safety validation and will not be signed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // --- Layer A: trusted display. Recover what the PCZT ACTUALLY does, bound to
  // the note commitments that will be signed — never the caller's signDetails.
  let summary: PcztSummary;
  try {
    summary = pczt_describe(NETWORK, pczt, ufvk) as PcztSummary;
  } catch (e) {
    throw new Error(
      `Unable to read the transaction from the PCZT: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const recipientOutputs = summary.outputs.filter((o) => !o.is_change);
  const verifiedOutgoing = recipientOutputs.reduce(
    (acc, o) => acc + BigInt(o.value),
    0n,
  );

  // Defense-in-depth: compare the site's claim against what the PCZT actually does.
  const claimedZats = zecToZats(signDetails.amount);
  const amountMatches = claimedZats === verifiedOutgoing;

  // Warn on extra outputs: a split payment can match the claimed total while routing
  // value to an attacker, so the aggregate amount check alone is not enough.
  const multiplePayments = recipientOutputs.length > 1;

  // Verify the claimed recipient against the PCZT: decode the site's address into its
  // per-pool receivers and confirm every non-change output pays one of them. An
  // undecodable address leaves this unverifiable — fall back to an eyeball prompt.
  let claimedReceivers:
    | { orchard: string | null; sapling: string | null; transparent: string | null }
    | null = null;
  try {
    claimedReceivers = JSON.parse(
      decode_address_receivers(NETWORK, signDetails.recipient),
    );
  } catch {
    claimedReceivers = null;
  }
  const recipientVerifiable = claimedReceivers !== null;
  const recipientMismatch =
    recipientVerifiable &&
    recipientOutputs.some((o) => {
      const claimed =
        o.pool === 'orchard'
          ? claimedReceivers!.orchard
          : o.pool === 'sapling'
            ? claimedReceivers!.sapling
            : o.pool === 'transparent'
              ? claimedReceivers!.transparent
              : null;
      return !claimed || o.recipient !== claimed;
    });

  // No recipient string-match warning: a full UA never equals our per-pool re-encoding,
  // so it false-fires on every send. Recipients are shown; extras are caught above.

  const verifiedSection = summary.outputs.flatMap((o) => [
    <Text>
      {o.is_change ? 'Change → your wallet' : 'Pays'}:{' '}
      <Bold>{shortAddr(o.recipient)}</Bold>
    </Text>,
    <Text>
      {`  ${zatsToZec(o.value)} ZEC (${o.pool})${
        o.verified ? ' ✓ verified' : ' ⚠ UNVERIFIED'
      }`}
    </Text>,
  ]);

  // NU6.3 Path-A migration: when the PCZT moves value into Ironwood, lead with a
  // migration-specific consent view carrying the authoritative (Layer A) amount and
  // the mandatory ZIP-315 public-amount warning. `migration.amount` comes from the
  // PCZT itself, not the caller. A destination that is not our own wallet is a hard
  // red flag (funds would leave to a third party under the guise of "migration").
  const migration = summary.migration;
  const migrationSection = migration ? (
    <Box>
      <Heading>Migrate to Ironwood</Heading>
      <Text>
        Moving <Bold>{`${zatsToZec(migration.amount)} ZEC`}</Bold> from your Orchard
        balance into the Ironwood pool.
      </Text>
      <Text>
        ⚠ <Bold>This amount will be revealed publicly on-chain.</Bold> Crossing the
        pool boundary exposes the transfer amount; approving is your consent to make
        it public.
      </Text>
      {migration.to_self && migration.is_clean_path_a ? (
        <Text>✓ Destination is your own wallet (self-migration).</Text>
      ) : !migration.to_self ? (
        <Text>
          ⚠ <Bold>WARNING: this does NOT migrate to your own wallet.</Bold> The
          Ironwood funds go to another address. Do not approve unless you intend to
          send them away.
        </Text>
      ) : (
        <Text>
          ⚠ <Bold>WARNING: this is not a clean self-migration.</Bold> Besides the
          migration to your own wallet, this transaction carries additional
          payments. Check every "Pays:" line above and do not approve unless you
          intend them.
        </Text>
      )}
      <Divider />
    </Box>
  ) : (
    <Text> </Text>
  );

  const content = (
    <Box>
      <Heading>{migration ? 'Migrate Zcash to Ironwood' : 'Sign Zcash transaction'}</Heading>
      <Text>Origin: {origin}</Text>
      <Divider />
      {migrationSection}
      <Heading>Verified from the PCZT</Heading>
      {verifiedSection}
      <Text>
        Total sent: <Bold>{`${zatsToZec(verifiedOutgoing)} ZEC`}</Bold> · Fee:{' '}
        <Bold>{`${zatsToZec(summary.fee)} ZEC`}</Bold>
      </Text>
      <Divider />
      <Heading>Requested by site</Heading>
      <Text>Recipient: {shortAddr(signDetails.recipient)}</Text>
      <Text>Amount: {`${signDetails.amount} ZEC`}</Text>
      {!amountMatches ? (
        <Text>
          ⚠ <Bold>WARNING</Bold>: the site requested {signDetails.amount} ZEC but
          the PCZT actually sends {zatsToZec(verifiedOutgoing)} ZEC. Do not
          approve unless you trust this.
        </Text>
      ) : (
        <Text> </Text>
      )}
      {multiplePayments ? (
        <Text>
          ⚠ <Bold>WARNING</Bold>: this transaction has{' '}
          {String(recipientOutputs.length)} separate payments, but the site
          described a single recipient. Check every "Pays:" line above — funds may
          be going somewhere you did not intend.
        </Text>
      ) : (
        <Text> </Text>
      )}
      {!recipientVerifiable ? (
        <Text>
          Confirm the verified recipient(s) above match who you intended to pay.
        </Text>
      ) : recipientMismatch ? (
        <Text>
          ⚠ <Bold>WARNING: the PCZT pays a different address than the site
          requested.</Bold> Do not approve unless you recognise the verified
          recipient(s) above.
        </Text>
      ) : (
        <Text>✓ Recipient matches the address the site requested.</Text>
      )}
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

  const pcztSigned = await pczt_sign(NETWORK, pczt, spendingKey, seedFp);
  return Buffer.from(pcztSigned.serialize()).toString('hex');
}
