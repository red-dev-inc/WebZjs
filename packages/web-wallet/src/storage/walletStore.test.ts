// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Store = typeof import('./walletStore');

const bytesOf = (text: string) => new TextEncoder().encode(text);

// idb-keyval caches its database connection per module instance, so every test gets a fresh
// IndexedDB and a freshly imported module. A second import in one test stands in for a second
// browser tab sharing the same storage.
async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('./walletStore');
}

// Raw IndexedDB helpers against the current global factory. idb-keyval itself lives in
// node_modules, which vitest does not reset, so its default connection would stick to the
// first test's database.
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('keyval-store');
    open.onupgradeneeded = () => open.result.createObjectStore('keyval');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction('keyval', mode).objectStore('keyval'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
    };
  });
}

const stored = (key: string) => withStore<unknown>('readonly', (store) => store.get(key));
const seed = (key: string, value: unknown) => withStore<IDBValidKey>('readwrite', (store) => store.put(value, key));

beforeEach(() => {
  // A fresh database per test; the module under test opens it lazily.
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
});

describe('saveWallet', () => {
  it('writes a versioned record, its metadata and the birthday mirror on first save', async () => {
    const store = await freshStore();
    const wallet = {};
    store.registerWallet(wallet, { epoch: null, birthday: 2_500_000 });

    const meta = await store.saveWallet(wallet, bytesOf('w1'), { reason: 'connect' });

    expect(meta.epoch).toBe(1);
    expect(meta.birthday).toBe(2_500_000);
    expect(meta.writerId).toBe(store.TAB_ID);
    const record = (await stored('wallet')) as { v: number; meta: { epoch: number } };
    expect(record.v).toBe(2);
    expect(record.meta.epoch).toBe(1);
    expect(await stored('wallet.meta')).toEqual(meta);
    expect(await stored('birthdayBlock')).toBe('2500000');
    expect(store.walletOrigin(wallet)).toEqual({ epoch: 1, birthday: 2_500_000 });
  });

  it('rejects a write from an instance behind storage and leaves storage untouched', async () => {
    const store = await freshStore();
    const current = {};
    const stale = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });
    store.registerWallet(stale, { epoch: 1, birthday: null });
    await store.saveWallet(current, bytesOf('v2'), { reason: 'sync' }); // storage -> epoch 2

    await expect(store.saveWallet(stale, bytesOf('stale'), { reason: 'sync' })).rejects.toBeInstanceOf(
      store.StaleWalletError,
    );

    const record = (await stored('wallet')) as { bytes: Uint8Array; meta: { epoch: number } };
    expect(new TextDecoder().decode(record.bytes)).toBe('v2');
    expect(record.meta.epoch).toBe(2);
    expect((await stored('wallet.meta')) as { epoch: number }).toMatchObject({ epoch: 2 });
  });

  it('lets a forced resync write win and strictly raises the epoch', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    for (let i = 0; i < 5; i++) await store.saveWallet(current, bytesOf(`v${i}`), { reason: 'sync' });

    const fresh = {};
    store.registerWallet(fresh, { epoch: null, birthday: 3_200_000 });
    const meta = await store.saveWallet(fresh, bytesOf('resynced'), { reason: 'resync', force: true });

    expect(meta.epoch).toBe(6);
    expect(meta.birthday).toBe(3_200_000);
    expect(await stored('birthdayBlock')).toBe('3200000');
    await expect(store.saveWallet(current, bytesOf('late'), { reason: 'sync' })).rejects.toBeInstanceOf(
      store.StaleWalletError,
    );
  });

  it('never writes from a superseded instance', async () => {
    const store = await freshStore();
    const wallet = {};
    store.registerWallet(wallet, { epoch: null, birthday: null });
    await store.saveWallet(wallet, bytesOf('v1'), { reason: 'sync' });

    store.markSuperseded(wallet);

    await expect(store.saveWallet(wallet, bytesOf('v2'), { reason: 'sync' })).rejects.toBeInstanceOf(
      store.StaleWalletError,
    );
    expect(await store.peekStoredEpoch()).toBe(1);
  });

  it('serializes concurrent saves of one instance', async () => {
    const store = await freshStore();
    const wallet = {};
    store.registerWallet(wallet, { epoch: null, birthday: null });

    const [a, b] = await Promise.all([
      store.saveWallet(wallet, bytesOf('a'), { reason: 'sync' }),
      store.saveWallet(wallet, bytesOf('b'), { reason: 'send' }),
    ]);

    expect([a.epoch, b.epoch]).toEqual([1, 2]);
    expect(await store.peekStoredEpoch()).toBe(2);
  });
});

describe('loadWallet', () => {
  it('migrates legacy bytes in memory at epoch 0 and converts them on the first save', async () => {
    await seed('wallet', bytesOf('legacy'));
    await seed('birthdayBlock', '2500000');
    const store = await freshStore();

    const loaded = await store.loadWallet((bytes) => ({ text: new TextDecoder().decode(bytes) }));
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.legacy).toBe(true);
    expect(loaded.meta).toMatchObject({ epoch: 0, birthday: 2_500_000, reason: 'legacy' });
    expect(await store.peekStoredEpoch()).toBe(0);

    await store.saveWallet(loaded.wallet, bytesOf('converted'), { reason: 'sync' });
    const record = (await stored('wallet')) as { v: number; meta: { epoch: number; birthday: number } };
    expect(record.v).toBe(2);
    expect(record.meta).toMatchObject({ epoch: 1, birthday: 2_500_000 });
  });

  it('keeps and backs up bytes that fail to decode, and the empty wallet cannot save', async () => {
    const original = bytesOf('corrupt');
    await seed('wallet', original);
    const store = await freshStore();

    const loaded = await store.loadWallet(() => {
      throw new Error('bad format');
    });

    expect(loaded.status).toBe('unreadable');
    expect(await stored('wallet')).toEqual(original);
    const backup = (await store.readWalletBackup())!;
    expect(new TextDecoder().decode(backup.bytes)).toBe('corrupt');
    expect(backup.error).toContain('bad format');

    const empty = {}; // not registered, like the context's fallback wallet
    await expect(store.saveWallet(empty, bytesOf('fresh'), { reason: 'recover' })).rejects.toBeInstanceOf(
      store.StaleWalletError,
    );
    expect(await stored('wallet')).toEqual(original);

    const forced = await store.saveWallet(empty, bytesOf('fresh'), { reason: 'recover', force: true });
    expect(forced.epoch).toBe(1);
  });

  it('returns none when nothing is stored', async () => {
    const store = await freshStore();
    expect(await store.loadWallet(() => ({}))).toEqual({ status: 'none' });
    expect(await store.peekStoredEpoch()).toBeNull();
  });
});

describe('two tabs sharing one storage', () => {
  it('lets each tab write only while it is current, and a resync beats both', async () => {
    const decode = (bytes: Uint8Array) => ({ text: new TextDecoder().decode(bytes) });
    await seed('wallet', bytesOf('shared'));

    const tabA = await freshStore();
    const loadedA = await tabA.loadWallet(decode);
    const tabB = await freshStore();
    const loadedB = await tabB.loadWallet(decode);
    if (loadedA.status !== 'ok' || loadedB.status !== 'ok') throw new Error('both tabs load');
    expect(tabA.TAB_ID).not.toBe(tabB.TAB_ID);

    await tabA.saveWallet(loadedA.wallet, bytesOf('a1'), { reason: 'sync' }); // epoch 1
    await expect(tabB.saveWallet(loadedB.wallet, bytesOf('b-stale'), { reason: 'sync' })).rejects.toBeInstanceOf(
      tabB.StaleWalletError,
    );

    const reloadedB = await tabB.loadWallet(decode);
    if (reloadedB.status !== 'ok') throw new Error('tab B reloads');
    expect(reloadedB.meta.epoch).toBe(1);
    await tabB.saveWallet(reloadedB.wallet, bytesOf('b2'), { reason: 'sync' }); // epoch 2
    await expect(tabA.saveWallet(loadedA.wallet, bytesOf('a-stale'), { reason: 'sync' })).rejects.toBeInstanceOf(
      tabA.StaleWalletError,
    );

    const resynced = {};
    tabA.registerWallet(resynced, { epoch: null, birthday: 3_200_000 });
    const meta = await tabA.saveWallet(resynced, bytesOf('resynced'), { reason: 'resync', force: true });
    expect(meta.epoch).toBe(3);
    await expect(tabB.saveWallet(reloadedB.wallet, bytesOf('b3'), { reason: 'sync' })).rejects.toBeInstanceOf(
      tabB.StaleWalletError,
    );
    const record = (await stored('wallet')) as { bytes: Uint8Array; meta: { writerId: string } };
    expect(new TextDecoder().decode(record.bytes)).toBe('resynced');
    expect(record.meta.writerId).toBe(tabA.TAB_ID);
  });
});

describe('a record that cannot be stored', () => {
  // Structured cloning rejects functions with a DataCloneError, the same error class the browser
  // raises when the renderer is out of memory. `put` throws it synchronously inside the request
  // callback, where an uncaught exception would leave the write promise pending forever.
  const uncloneable = { toJSON() {} } as unknown as Uint8Array;

  it('saveWallet rejects and leaves the stored wallet as it was', async () => {
    const store = await freshStore();
    const wallet = {};
    store.registerWallet(wallet, { epoch: null, birthday: null });
    await store.saveWallet(wallet, bytesOf('v1'), { reason: 'sync' });

    await expect(store.saveWallet(wallet, uncloneable, { reason: 'sync' })).rejects.toMatchObject({
      name: 'DataCloneError',
    });

    const record = (await stored('wallet')) as { bytes: Uint8Array; meta: { epoch: number } };
    expect(new TextDecoder().decode(record.bytes)).toBe('v1');
    expect(record.meta.epoch).toBe(1);
    expect(store.walletOrigin(wallet)).toMatchObject({ epoch: 1 });
    // The instance can still save afterwards.
    await store.saveWallet(wallet, bytesOf('v2'), { reason: 'sync' });
    expect(await store.peekStoredEpoch()).toBe(2);
  });

  it('stageWallet rejects and leaves the previous checkpoint in place', async () => {
    const store = await freshStore();
    const fresh = {};
    await store.stageWallet(fresh, bytesOf('partial'), { birthday: 1, fullyScanned: 2, chainTip: 3 });

    await expect(
      store.stageWallet(fresh, uncloneable, { birthday: 1, fullyScanned: 4, chainTip: 5 }),
    ).rejects.toMatchObject({ name: 'DataCloneError' });

    const staged = (await store.readStaging())!;
    expect(new TextDecoder().decode(staged.bytes)).toBe('partial');
    expect(staged.meta.fullyScanned).toBe(2);
  });
});

describe('resync checkpoints', () => {
  const stagedMeta = { birthday: 2_600_000, fullyScanned: 2_700_000, chainTip: 3_500_000 };

  it('readStaging returns null when nothing is staged', async () => {
    const store = await freshStore();
    expect(await store.readStaging()).toBeNull();
  });

  it('stages a checkpoint without touching the stored wallet', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });
    const fresh = {};
    store.registerWallet(fresh, { epoch: null, birthday: 2_600_000 });

    const meta = await store.stageWallet(fresh, bytesOf('partial'), stagedMeta);

    expect(meta).toMatchObject({ epoch: 2, reason: 'resync', ...stagedMeta });
    const staged = (await store.readStaging())!;
    expect(new TextDecoder().decode(staged.bytes)).toBe('partial');
    expect(staged.meta).toEqual(meta);
    expect(store.stagingIsResumable(staged.meta)).toBe(true);
    expect(await store.peekStoredEpoch()).toBe(1);
    const record = (await stored('wallet')) as { bytes: Uint8Array };
    expect(new TextDecoder().decode(record.bytes)).toBe('v1');
    expect(store.walletOrigin(fresh)).toEqual({ epoch: null, birthday: 2_600_000 });
  });

  it('a checkpoint at the chain tip is not resumable', async () => {
    const store = await freshStore();
    const fresh = {};
    await store.stageWallet(fresh, bytesOf('done'), { ...stagedMeta, fullyScanned: 3_499_998 });
    expect(store.stagingIsResumable((await store.readStaging())!.meta)).toBe(false);
  });

  it('promotes the checkpoint at the next epoch, keeps the previous wallet and clears staging', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: 2_400_000 });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });
    await store.saveWallet(current, bytesOf('v2'), { reason: 'sync' });
    const fresh = {};
    store.registerWallet(fresh, { epoch: null, birthday: 2_600_000 });
    await store.stageWallet(fresh, bytesOf('resynced'), { ...stagedMeta, fullyScanned: 3_500_000 });

    const meta = await store.promoteStaging(fresh);

    expect(meta).toMatchObject({ epoch: 3, birthday: 2_600_000, fullyScanned: 3_500_000, reason: 'resync' });
    const record = (await stored('wallet')) as { bytes: Uint8Array; meta: unknown };
    expect(new TextDecoder().decode(record.bytes)).toBe('resynced');
    expect(record.meta).toEqual(meta);
    expect(await stored('wallet.meta')).toEqual(meta);
    expect(await stored('birthdayBlock')).toBe('2600000');
    const previous = (await stored('wallet.backup.previous')) as { bytes: Uint8Array; meta: { epoch: number } };
    expect(new TextDecoder().decode(previous.bytes)).toBe('v2');
    expect(previous.meta.epoch).toBe(2);
    expect(await store.readStaging()).toBeNull();
    expect(store.walletOrigin(fresh)).toEqual({ epoch: 3, birthday: 2_600_000 });
    await expect(store.saveWallet(current, bytesOf('late'), { reason: 'sync' })).rejects.toBeInstanceOf(
      store.StaleWalletError,
    );
    await store.saveWallet(fresh, bytesOf('v4'), { reason: 'sync' });
    expect(await store.peekStoredEpoch()).toBe(4);
  });

  it('promotes over an empty store at epoch 1', async () => {
    const store = await freshStore();
    const fresh = {};
    await store.stageWallet(fresh, bytesOf('first'), stagedMeta);
    const meta = await store.promoteStaging(fresh);
    expect(meta.epoch).toBe(1);
    expect(await stored('wallet.backup.previous')).toBeUndefined();
  });

  it('rejects promotion when nothing is staged and changes nothing', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });

    await expect(store.promoteStaging({})).rejects.toThrow(/no checkpointed resync/);
    expect(await store.peekStoredEpoch()).toBe(1);
  });

  it('leaves the wallet untouched and the checkpoint in place when the promotion fails midway', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });
    const fresh = {};
    await store.stageWallet(fresh, bytesOf('partial'), stagedMeta);

    // The wallet record is already written inside the transaction when the metadata write
    // throws; the whole transaction must roll back.
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (key === 'wallet.meta') throw new Error('disk full');
      return put.call(this, value, key);
    });
    try {
      await expect(store.promoteStaging(fresh)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }

    const record = (await stored('wallet')) as { bytes: Uint8Array; meta: { epoch: number } };
    expect(new TextDecoder().decode(record.bytes)).toBe('v1');
    expect(record.meta.epoch).toBe(1);
    expect(await stored('wallet.backup.previous')).toBeUndefined();
    const staged = (await store.readStaging())!;
    expect(new TextDecoder().decode(staged.bytes)).toBe('partial');
    expect(store.walletOrigin(fresh)).toBeUndefined();
  });

  it('clearStaging removes the checkpoint only', async () => {
    const store = await freshStore();
    const current = {};
    store.registerWallet(current, { epoch: null, birthday: null });
    await store.saveWallet(current, bytesOf('v1'), { reason: 'sync' });
    await store.stageWallet({}, bytesOf('partial'), stagedMeta);

    await store.clearStaging();

    expect(await store.readStaging()).toBeNull();
    expect(await store.peekStoredEpoch()).toBe(1);
    await expect(store.clearStaging()).resolves.toBeUndefined();
  });
});
