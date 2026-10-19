/**
 * Reads the account birthday straight out of a serialized wallet blob, without the wasm
 * module. The blob is the protobuf `memwallet.MemoryWallet`; only its top level and the
 * account birthday are walked, everything else is skipped by length.
 *
 * Used to make the blob's own birthday the source of truth for stored metadata, instead of
 * the separately stored `birthdayBlock` mirror, which can lag or be clobbered.
 */

interface Field {
  num: number;
  wire: number;
  /** Varint value for wire type 0, or the raw bytes for wire type 2. */
  value: number | Uint8Array;
}

function parseMessage(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated varint');
      const b = bytes[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
  };
  while (i < bytes.length) {
    const key = varint();
    const num = Math.floor(key / 8);
    const wire = key % 8;
    switch (wire) {
      case 0:
        fields.push({ num, wire, value: varint() });
        break;
      case 1:
        i += 8;
        break;
      case 2: {
        const len = varint();
        if (i + len > bytes.length) throw new Error('truncated field');
        fields.push({ num, wire, value: bytes.subarray(i, i + len) });
        i += len;
        break;
      }
      case 5:
        i += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const bytesOf = (fields: Field[], num: number): Uint8Array | undefined => {
  const f = fields.find((x) => x.num === num && x.wire === 2);
  return f ? (f.value as Uint8Array) : undefined;
};

const numberOf = (fields: Field[], num: number): number | undefined => {
  const f = fields.find((x) => x.num === num && x.wire === 0);
  return f ? (f.value as number) : undefined;
};

/**
 * The lowest account birthday height in the blob, or null if the blob has no account or
 * cannot be walked. `MemoryWallet.accounts (2) -> Accounts.accounts (1, repeated) ->
 * Account.birthday (7) -> AccountBirthday.prior_chain_state (1) -> ChainState.block_height (1)`;
 * the birthday is the height after the prior chain state.
 */
export function readBlobBirthday(bytes: Uint8Array): number | null {
  try {
    const top = parseMessage(bytes);
    const accounts = bytesOf(top, 2);
    if (!accounts) return null;
    let birthday: number | null = null;
    for (const field of parseMessage(accounts)) {
      if (field.num !== 1 || field.wire !== 2) continue;
      const account = parseMessage(field.value as Uint8Array);
      const accountBirthday = bytesOf(account, 7);
      if (!accountBirthday) continue;
      const chainState = bytesOf(parseMessage(accountBirthday), 1);
      if (!chainState) continue;
      const priorHeight = numberOf(parseMessage(chainState), 1);
      if (priorHeight === undefined) continue;
      const height = priorHeight + 1;
      birthday = birthday === null ? height : Math.min(birthday, height);
    }
    return birthday;
  } catch {
    return null;
  }
}
