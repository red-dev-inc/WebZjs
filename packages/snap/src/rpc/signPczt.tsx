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
} from '@chainsafe/webzjs-keys';
import { getSeed } from '../utils/getSeed';
import { SignPcztParams } from 'src/types';

/** Network the Snap operates on (coinType 133 = Zcash mainnet). */
const NETWORK = 'main';
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
  verified: boolean;
};

/** Trusted-display summary recovered from a PCZT. Mirrors `PcztSummary`. */
type PcztSummary = {
  network: string;
  outputs: PcztOutputSummary[];
  total_in: number | bigint;
  total_out: number | bigint;
  fee: number | bigint;
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
  if (!/^[0-9a-fA-F]+$/.test(pcztHexTring)) {
    throw new Error('pcztHexTring must be valid hex');
  }
  const pcztUint8Array = new Uint8Array(Buffer.from(pcztHexTring, 'hex'));
  const pczt = Pczt.from_bytes(pcztUint8Array);

  const seed = await getSeed();
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

  // Defense-in-depth: compare the site's claim against the verified output.
  // The amount is authoritative; the recipient is shown for the user to eyeball
  // (a full Unified Address won't string-match our orchard-only re-encoding).
  const claimedZats = zecToZats(signDetails.amount);
  const amountMatches = claimedZats === verifiedOutgoing;
  const recipientMatches = recipientOutputs.some(
    (o) => o.recipient === signDetails.recipient,
  );

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

  const content = (
    <Box>
      <Heading>Sign Zcash transaction</Heading>
      <Text>Origin: {origin}</Text>
      <Divider />
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
      {!recipientMatches ? (
        <Text>
          ⚠ Confirm the verified recipient above matches who you intended to pay.
        </Text>
      ) : (
        <Text> </Text>
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
