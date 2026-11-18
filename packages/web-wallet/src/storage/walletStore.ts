/**
 * The only module that reads or writes the wallet in IndexedDB.
 *
 * Invariant: a wallet is written only if the instance writing it descends from what is
 * stored right now (same epoch), or the write is an explicit resync or recovery that is
 * allowed to win. The check and the write happen in one IndexedDB transaction, so a stale
 * instance in any tab, hook or closure can never overwrite newer data.
 *
 * Keys (all in idb-keyval's default database and store, so older builds' data is visible):
 * - `wallet`         WalletRecord, or a bare Uint8Array written by older builds (epoch 0)
 * - `wallet.meta`    WalletMeta of the stored record, cheap to read on its own
 * - `wallet.backup`  bytes that failed to load, kept until the user decides
 * - `birthdayBlock`  mirror of the stored birthday, kept for the snap-state fallback
 */
import { createStore, get, promisifyRequest, set, type UseStore } from 'idb-keyval';

import { readBlobBirthday } from './walletBlobMeta';

export type SaveReason = 'connect' | 'sync' | 'send' | 'resync' | 'recover';

export interface WalletMeta {
  /** Bumped on every successful write; the ordering authority. */
  epoch: number;
  /** Birthday read out of the blob itself, or null when the blob has no account. */
  birthday: number | null;
  fullyScanned: number | null;
  savedAt: number;
  writerId: string;
  reason: SaveReason | 'legacy';
}

export interface WalletRecord {
  v: 2;
  bytes: Uint8Array;
  meta: WalletMeta;
}

export interface WalletBackup {
  bytes: Uint8Array;
  meta: WalletMeta | null;
  error: string;
  failedAt: number;
}

/** What an in-memory instance believes is stored: the epoch it was loaded from or last saved at. */
export interface WalletOrigin {
  /** null: never persisted and expects no stored wallet. SUPERSEDED: may never write again. */
  epoch: number | null;
  birthday: number | null;
}

export type LoadResult<W> =
  | { status: 'none' }
  | { status: 'ok'; wallet: W; meta: WalletMeta; legacy: boolean }
  | { status: 'unreadable'; error: unknown; meta: WalletMeta | null };

export interface SaveOptions {
  reason: SaveReason;
  /** Used only when the blob itself carries no birthday. */
  birthday?: number | null;
  fullyScanned?: number | null;
  /** Skip the epoch check. Only for a completed resync or an explicit recovery. */
  force?: boolean;
}

export class StaleWalletError extends Error {
  constructor(
    readonly expected: number | null,
    readonly stored: number | null,
  ) {
    super(
      `Refusing to save the wallet: this instance was loaded at epoch ${expected}, storage is at epoch ${stored}`,
    );
    this.name = 'StaleWalletError';
  }
}

export const WALLET_KEY = 'wallet';
export const META_KEY = 'wallet.meta';
export const BACKUP_KEY = 'wallet.backup';
export const BIRTHDAY_KEY = 'birthdayBlock';
const CHANNEL_NAME = 'webzjs-wallet';
const WRITER_LOCK = 'webzjs-wallet-writer';
export const SUPERSEDED = -1;

export const TAB_ID: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

// Same database and store idb-keyval uses by default, opened on first use so that importing
// this module needs no IndexedDB (component tests run without one).
let storeRef: UseStore | undefined;
function store<T>(mode: IDBTransactionMode, callback: (objectStore: IDBObjectStore) => T | PromiseLike<T>): Promise<T> {
  storeRef ??= createStore('keyval-store', 'keyval');
  return storeRef(mode, callback);
}

const origins = new WeakMap<object, WalletOrigin>();

export function registerWallet(wallet: object, origin: WalletOrigin): void {
  origins.set(wallet, origin);
}

export function walletOrigin(wallet: object): WalletOrigin | undefined {
  return origins.get(wallet);
}

/** After this the instance can never write; used when another instance replaces it. */
export function markSuperseded(wallet: object): void {
  origins.set(wallet, { epoch: SUPERSEDED, birthday: origins.get(wallet)?.birthday ?? null });
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || ArrayBuffer.isView(value);
}

function isRecord(value: unknown): value is WalletRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as WalletRecord).v === 2 &&
    isBytes((value as WalletRecord).bytes) &&
    typeof (value as WalletRecord).meta?.epoch === 'number'
  );
}

/** The epoch a stored value represents: nothing → null, legacy bytes → 0, record → its epoch. */
function epochOf(stored: unknown): number | null {
  if (stored === undefined || stored === null) return null;
  if (isBytes(stored)) return 0;
  if (isRecord(stored)) return stored.meta.epoch;
  return 0;
}

function toHeight(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Saves from one tab run one at a time so two saves of the same instance cannot race each
// other's registry update.
let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const result = writes.then(job);
  writes = result.catch(() => undefined);
  return result;
}

/**
 * Loads the stored wallet. A bare byte array from an older build is migrated in memory (epoch 0)
 * and converted on its first save. Bytes that fail to decode are copied to `wallet.backup` and
 * left in place; the caller must not register the empty wallet it builds instead, so that every
 * unforced save is rejected until the user explicitly replaces the stored data.
 */
export async function loadWallet<W extends object>(
  decode: (bytes: Uint8Array) => W,
): Promise<LoadResult<W>> {
  const stored = await get(WALLET_KEY, store);
  if (stored === undefined || stored === null) return { status: 'none' };

  let bytes: Uint8Array;
  let meta: WalletMeta | null;
  let legacy = false;
  if (isBytes(stored)) {
    bytes = stored;
    legacy = true;
    const mirrored = toHeight(await get(BIRTHDAY_KEY, store));
    meta = {
      epoch: 0,
      birthday: readBlobBirthday(bytes) ?? mirrored,
      fullyScanned: null,
      savedAt: 0,
      writerId: '',
      reason: 'legacy',
    };
  } else if (isRecord(stored)) {
    bytes = stored.bytes;
    meta = stored.meta;
  } else {
    return { status: 'unreadable', error: new Error('Stored wallet has an unknown shape'), meta: null };
  }

  try {
    const wallet = decode(bytes);
    registerWallet(wallet, { epoch: meta.epoch, birthday: meta.birthday });
    return { status: 'ok', wallet, meta, legacy };
  } catch (error) {
    const backup: WalletBackup = {
      bytes,
      meta: legacy ? null : meta,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      failedAt: Date.now(),
    };
    try {
      await set(BACKUP_KEY, backup, store);
    } catch (backupError) {
      console.error('Could not back up the unreadable wallet bytes:', backupError);
    }
    return { status: 'unreadable', error, meta: legacy ? null : meta };
  }
}

/**
 * Compare-and-swap write of the wallet, its metadata and the birthday mirror in one
 * transaction. Throws StaleWalletError, and writes nothing, when storage is not at the epoch
 * this instance expects, unless `force` is set. On success the instance's origin moves to the
 * new epoch and other tabs are told.
 */
export function saveWallet(wallet: object, bytes: Uint8Array, opts: SaveOptions): Promise<WalletMeta> {
  return serialize(async () => {
    const origin = origins.get(wallet);
    const expected = origin ? origin.epoch : null;
    if (expected === SUPERSEDED) {
      throw new StaleWalletError(expected, null);
    }
    const birthday = readBlobBirthday(bytes) ?? opts.birthday ?? origin?.birthday ?? null;

    const meta = await store(
      'readwrite',
      (objectStore) =>
        new Promise<WalletMeta>((resolve, reject) => {
          const request = objectStore.get(WALLET_KEY);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const storedEpoch = epochOf(request.result);
            if (!opts.force && storedEpoch !== expected) {
              objectStore.transaction.abort();
              reject(new StaleWalletError(expected, storedEpoch));
              return;
            }
            const next: WalletMeta = {
              epoch: (storedEpoch ?? 0) + 1,
              birthday,
              fullyScanned: opts.fullyScanned ?? null,
              savedAt: Date.now(),
              writerId: TAB_ID,
              reason: opts.reason,
            };
            const record: WalletRecord = { v: 2, bytes, meta: next };
            objectStore.put(record, WALLET_KEY);
            objectStore.put(next, META_KEY);
            if (birthday !== null) {
              objectStore.put(String(birthday), BIRTHDAY_KEY);
            }
            resolve(promisifyRequest(objectStore.transaction).then(() => next));
          };
        }),
    );

    origins.set(wallet, { epoch: meta.epoch, birthday: meta.birthday });
    broadcast({ type: 'saved', epoch: meta.epoch, writerId: TAB_ID });
    return meta;
  });
}

/** Epoch of what is stored: record epoch, 0 for legacy bytes, null when nothing is stored. */
export async function peekStoredEpoch(): Promise<number | null> {
  const meta = (await get(META_KEY, store)) as WalletMeta | undefined;
  if (meta && typeof meta.epoch === 'number') return meta.epoch;
  return epochOf(await get(WALLET_KEY, store));
}

export async function readWalletBackup(): Promise<WalletBackup | null> {
  return ((await get(BACKUP_KEY, store)) as WalletBackup | undefined) ?? null;
}

export interface WalletChangedMessage {
  type: 'saved';
  epoch: number;
  writerId: string;
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

function broadcast(message: WalletChangedMessage): void {
  try {
    channel?.postMessage(message);
  } catch (error) {
    console.warn('Could not notify other tabs of the wallet save:', error);
  }
}

/** Calls `cb` when another tab saves the wallet. Returns the unsubscribe function. */
export function onWalletChanged(cb: (message: WalletChangedMessage) => void): () => void {
  if (!channel) return () => undefined;
  const listener = (event: MessageEvent<WalletChangedMessage>) => {
    const message = event.data;
    if (message?.type === 'saved' && message.writerId !== TAB_ID) cb(message);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

/**
 * Holds the single-writer lock for the life of this tab and calls `onClaimed` once it is
 * held. Tabs that do not hold it should not run periodic syncs. Where Web Locks are not
 * available every tab is a writer; the epoch check keeps that safe, only less efficient.
 */
export function claimWriterRole(onClaimed: () => void): void {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    onClaimed();
    return;
  }
  void locks
    .request(WRITER_LOCK, () => {
      onClaimed();
      // Never resolves: the lock is released when the tab goes away.
      return new Promise<void>(() => undefined);
    })
    .catch((error) => {
      console.warn('Writer lock unavailable, continuing as a writer:', error);
      onClaimed();
    });
}
