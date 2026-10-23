use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use futures_util::future::{select, Either};
use nonempty::NonEmpty;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Notify};
use wasm_bindgen::prelude::*;

use tonic_web_wasm_client::Client;

use crate::error::Error;
use crate::validation::validate_confirmations_policy;
use crate::wallet::usk_from_seed_str;
use crate::{bindgen::proposal::Proposal, Wallet, PRUNING_DEPTH};
use futures_util::TryStreamExt;
use wasm_thread as thread;
use webzjs_common::{Network, Pczt};
use webzjs_keys::{ProofGenerationKey, SeedFingerprint};
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::{AccountPurpose, InputSource, WalletRead, Zip32Derivation};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec,
    TransparentAddressBlockFilter,
};
use zcash_client_memory::MemoryWalletDb;
use zcash_keys::encoding::AddressCodec;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_primitives::transaction::TxId;

pub type MemoryWallet<T> = Wallet<MemoryWalletDb<Network>, T>;
pub type AccountId = <MemoryWalletDb<Network> as WalletRead>::AccountId;
pub type NoteRef = <MemoryWalletDb<Network> as InputSource>::NoteRef;

/// What a [`SyncRequest`] asks the sync worker to do.
enum SyncKind {
    /// Sync until no scan work remains (`Wallet::sync`).
    Full,
    /// One bounded step (`Wallet::sync_step`); `first` refreshes the subtree roots.
    Step { first: bool },
}

/// Why a request failed inside the sync worker.
///
/// `Error` holds a `JsValue` and is not `Send`, so the worker cannot reply with it directly. The
/// closed case is kept apart so the caller can surface it as `Error::InstanceClosed` again.
enum SyncFailure {
    InstanceClosed,
    Other(String),
}

impl From<Error> for SyncFailure {
    fn from(e: Error) -> Self {
        match e {
            Error::InstanceClosed => SyncFailure::InstanceClosed,
            other => SyncFailure::Other(other.to_string()),
        }
    }
}

/// One `WebWallet::sync` or `WebWallet::sync_step` call, handed to the sync worker.
struct SyncRequest {
    wallet: MemoryWallet<Client>,
    kind: SyncKind,
    /// `Ok(true)` if more sync work remains (only ever for `SyncKind::Step`), `Ok(false)` otherwise.
    reply: oneshot::Sender<Result<bool, SyncFailure>>,
}

/// Set once JS has reported that the sync worker trapped; see [`report_sync_worker_trap`].
static SYNC_WORKER_POISONED: AtomicBool = AtomicBool::new(false);

/// Wakes callers waiting on a reply from the sync worker when it is reported as trapped.
fn sync_worker_poison_signal() -> &'static Notify {
    static SIGNAL: OnceLock<Notify> = OnceLock::new();
    SIGNAL.get_or_init(Notify::new)
}

/// Tell the library that the shared sync worker has trapped and will never reply again.
///
/// A Rust panic inside the sync worker compiles to a wasm trap. The library cannot observe it: the
/// worker's event loop simply stops, the request it was running never resolves, and anything queued
/// behind it would wait forever. The browser does report it, as an uncaught
/// `RuntimeError: unreachable` delivered to the window's `error` event (the message comes from the
/// worker thread, so it is not thrown by the `sync` promise). Call this function from that handler.
///
/// After this call every in-flight and future `sync` / `sync_step` call rejects with
/// "the sync worker stopped after an internal error; reload the page" instead of hanging. The
/// worker is not restarted; the wallet state may be mid-update, so the page should persist nothing
/// further from this instance and reload. Calling it more than once is harmless.
///
/// # Examples
///
/// ```javascript
/// window.addEventListener("error", (event) => {
///   if (event.message && event.message.includes("unreachable")) {
///     report_sync_worker_trap();
///   }
/// });
/// ```
#[wasm_bindgen]
pub fn report_sync_worker_trap() {
    if !SYNC_WORKER_POISONED.swap(true, Ordering::SeqCst) {
        tracing::error!("sync worker reported as trapped; refusing further sync requests");
    }
    sync_worker_poison_signal().notify_waiters();
}

/// Whether [`report_sync_worker_trap`] has been called.
fn sync_worker_poisoned() -> bool {
    SYNC_WORKER_POISONED.load(Ordering::SeqCst)
}

/// The single web worker that runs every `WebWallet::sync` and `WebWallet::sync_step` call,
/// spawned on first use.
///
/// Each call used to spawn its own worker. Those workers are never torn down: `wasm_thread` is built
/// with `keep_worker_alive`, and a worker's thread-locals are not dropped even when it is closed.
/// The tracing registry gives each thread that creates a span one of only 128 slots on wasm32 and
/// relies on the thread-local drop to hand it back, so the periodic rescan exhausted the slots after
/// about 128 syncs (around 75 minutes at the default interval) and the next sync panicked with
/// "Thread count overflowed the configured max count". Reusing one worker keeps the thread count,
/// and the memory held by idle workers, constant. Requests run one at a time, in order.
fn sync_worker() -> &'static mpsc::UnboundedSender<SyncRequest> {
    static WORKER: OnceLock<mpsc::UnboundedSender<SyncRequest>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, mut rx) = mpsc::unbounded_channel::<SyncRequest>();
        thread::Builder::new()
            .name("sync".to_string())
            .spawn_async(move || async move {
                assert!(thread::is_web_worker_thread());
                while let Some(SyncRequest {
                    wallet,
                    kind,
                    reply,
                }) = rx.recv().await
                {
                    let result = match kind {
                        SyncKind::Full => wallet.sync().await.map(|()| false),
                        SyncKind::Step { first } => wallet.sync_step(first).await,
                    };
                    // The caller only goes away if its future was dropped; nothing to do then.
                    let _ = reply.send(result.map_err(SyncFailure::from));
                }
            })
            .unwrap_throw();
        tx
    })
}

/// # A Zcash wallet
///
/// This is the main entry point for interacting with this library.
/// For the most part you will only need to create and interact with a Wallet instance.
///
/// A wallet is a set of accounts that can be synchronized together with the blockchain.
/// Once synchronized, the wallet can be used to propose, build and send transactions.
///
/// Create a new WebWallet with
/// ```javascript
/// const wallet = new WebWallet("main", "https://zcash-mainnet.chainsafe.dev", 10);
/// ```
///
/// ## Adding Accounts
///
/// Accounts can be added by either importing a seed phrase or a Unified Full Viewing Key (UFVK).
/// If you do import via a UFVK it is important that you also have access to the Unified Spending Key (USK) for that account otherwise the wallet will not be able to create transactions.
///
/// When importing an account you can also specify the block height at which the account was created. This can significantly reduce the time it takes to sync the account as the wallet will only scan for transactions after this height.
/// Failing to provide a birthday height will result in extremely slow sync times as the wallet will need to scan the entire blockchain.
///
/// e.g.
/// ```javascript
/// const account_id = await wallet.create_account("...", 1, 2657762)
///
/// // OR
///
/// const account_id = await wallet.import_ufvk("...", 2657762)
/// ``
///
/// ## Synchronizing
///
/// The wallet can be synchronized with the blockchain by calling the `sync` method. This will fetch compact blocks from the connected lightwalletd instance and scan them for transactions.
/// The sync method uses a built-in strategy to determine which blocks is needs to download and scan in order to gain full knowledge of the balances for all accounts that are managed.
///
/// Syncing is a long running process and so is delegated to a WebWorker to prevent from blocking the main thread. It is safe to call other methods on the wallet during syncing although they may take
/// longer than usual while they wait for a write-lock to be released.
///
/// ```javascript
/// await wallet.sync();
/// ```
///
/// A sync can also be driven one bounded step at a time with `sync_step`, which releases the wallet lock between
/// steps so the wallet can be persisted with `db_to_bytes` as it goes and stopped with `close`:
///
/// ```javascript
/// let first = true;
/// while (await wallet.sync_step(first)) {
///   first = false;
///   await persist(await wallet.db_to_bytes());
/// }
/// ```
///
/// ## Transacting
///
/// Sending a transaction is a three step process: proposing, authorizing, and sending.
///
/// A transaction proposal is created by calling `propose_transfer` with the intended recipient and amount. This will create a proposal object that describes which notes will be spent in order to fulfil this request.
/// The proposal should be presented to the user for review before being authorized.
///
/// To authorize the transaction the caller must currently provide the seed phrase and account index of the account that will be used to sign the transaction. This method also perform the SNARK proving which is an expensive operation and performed in parallel by a series of WebWorkers.
///
/// Finally, A transaction can be sent to the network by calling `send_authorized_transactions` with the list of transaction IDs that were generated by the authorization step.
///
/// ## PCZT Transactions
///
/// PCZT (Partially Constructed Zcash Transaction)
///
/// 1. **`pczt_create`** - Creates a PCZT which designates how funds from this account can be spent to realize the requested transfer (does NOT sign, generate proofs, or send)
/// 2. **`pczt_sign`** - Signs the PCZT using USK (should be done in secure environment)
/// 3. **`pczt_prove`** - Creates and inserts proofs for the PCZT
///
/// The full flow looks like
/// The full PCZT flow: `pczt_create` → `pczt_sign` → `pczt_prove` → `pczt_send`
/// ```
///
#[wasm_bindgen]
#[derive(Clone)]
pub struct WebWallet {
    inner: MemoryWallet<tonic_web_wasm_client::Client>,
}

impl WebWallet {
    pub fn client(&self) -> CompactTxStreamerClient<tonic_web_wasm_client::Client> {
        self.inner.client.clone()
    }

    pub fn inner_mut(&mut self) -> &mut MemoryWallet<tonic_web_wasm_client::Client> {
        &mut self.inner
    }
}

#[wasm_bindgen]
impl WebWallet {
    /// Create a new instance of a Zcash wallet for a given network. Only one instance should be created per page.
    ///
    /// # Arguments
    ///
    /// * `network` - Must be one of "main" or "test"
    /// * `lightwalletd_url` - Url of the lightwalletd instance to connect to (e.g. https://zcash-mainnet.chainsafe.dev)
    /// * `min_confirmations` - Number of confirmations required before a transaction is considered final
    /// * `db_bytes` - (Optional) UInt8Array of a serialized wallet database. This can be used to restore a wallet from a previous session that was serialized by `db_to_bytes`
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const wallet = new WebWallet("main", "https://zcash-mainnet.chainsafe.dev", 10);
    /// ```
    #[wasm_bindgen(constructor)]
    pub fn new(
        network: &str,
        lightwalletd_url: &str,
        min_confirmations_trusted: u32,
        min_confirmations_untrusted: u32,
        db_bytes: Option<Box<[u8]>>,
    ) -> Result<WebWallet, Error> {
        let network = Network::from_str(network)?;
        let min_confirmations = validate_confirmations_policy(
            min_confirmations_trusted,
            min_confirmations_untrusted,
            true,
        )
        .map_err(|_| Error::InvalidMinConformations)?;
        let client = Client::new(lightwalletd_url.to_string());

        let db = match db_bytes {
            Some(bytes) => {
                tracing::info!(
                    "Serialized db was provided to constructor. Attempting to deserialize"
                );
                MemoryWalletDb::decode_new(bytes.as_ref(), network, PRUNING_DEPTH)?
            }
            None => MemoryWalletDb::new(network, PRUNING_DEPTH),
        };

        Ok(Self {
            inner: Wallet::new(db, client, network, min_confirmations)?,
        })
    }

    /// Add a new account to the wallet using a given seed phrase
    ///
    /// # Arguments
    ///
    /// * `seed_phrase` - 24 word mnemonic seed phrase
    /// * `account_hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
    /// * `birthday_height` - Block height at which the account was created. The sync logic will assume no funds are send or received prior to this height which can VERY significantly reduce sync time
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const wallet = new WebWallet("main", "https://zcash-mainnet.chainsafe.dev", 10);
    /// const account_id = await wallet.create_account("...", 1, 2657762)
    /// ```
    pub async fn create_account(
        &self,
        account_name: &str,
        seed_phrase: &str,
        account_hd_index: u32,
        birthday_height: Option<u32>,
    ) -> Result<u32, Error> {
        tracing::info!("Create account called");
        self.inner
            .create_account(
                account_name,
                seed_phrase,
                account_hd_index,
                birthday_height,
                None,
            )
            .await
            .map(|id| *id)
    }

    /// Add a new account to the wallet by directly importing a Unified Full Viewing Key (UFVK)
    ///
    /// # Arguments
    ///
    /// * `key` - [ZIP316](https://zips.z.cash/zip-0316) encoded UFVK
    /// * `birthday_height` - Block height at which the account was created. The sync logic will assume no funds are send or received prior to this height which can VERY significantly reduce sync time
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const wallet = new WebWallet("main", "https://zcash-mainnet.chainsafe.dev", 10);
    /// const account_id = await wallet.import_ufvk("...", 2657762)
    /// ```
    pub async fn create_account_ufvk(
        &self,
        account_name: &str,
        encoded_ufvk: &str,
        seed_fingerprint: SeedFingerprint,
        account_hd_index: u32,
        birthday_height: Option<u32>,
    ) -> Result<u32, Error> {
        let ufvk = UnifiedFullViewingKey::decode(&self.inner.network, encoded_ufvk)
            .map_err(Error::KeyParse)?;
        let derivation = Some(Zip32Derivation::new(
            seed_fingerprint.into(),
            zip32::AccountId::try_from(account_hd_index)?,
        ));
        self.inner
            .import_ufvk(
                account_name,
                &ufvk,
                AccountPurpose::Spending { derivation },
                birthday_height,
                None,
            )
            .await
            .map(|id| *id)
    }

    /// Add a new view-only account to the wallet by directly importing a Unified Full Viewing Key (UFVK)
    ///
    /// # Arguments
    ///
    /// * `key` - [ZIP316](https://zips.z.cash/zip-0316) encoded UFVK
    /// * `birthday_height` - Block height at which the account was created. The sync logic will assume no funds are send or received prior to this height which can VERY significantly reduce sync time
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const wallet = new WebWallet("main", "https://zcash-mainnet.chainsafe.dev", 10);
    /// const account_id = await wallet.import_ufvk("...", 2657762)
    /// ```
    pub async fn create_account_view_ufvk(
        &self,
        account_name: &str,
        encoded_ufvk: &str,
        birthday_height: Option<u32>,
    ) -> Result<u32, Error> {
        let ufvk = UnifiedFullViewingKey::decode(&self.inner.network, encoded_ufvk)
            .map_err(Error::KeyParse)?;

        self.inner
            .import_ufvk(
                account_name,
                &ufvk,
                AccountPurpose::ViewOnly,
                birthday_height,
                None,
            )
            .await
            .map(|id| *id)
    }

    ///
    /// Start a background sync task which will fetch and scan blocks from the connected lighwalletd server
    ///
    /// IMPORTANT: The sync runs on a dedicated webworker that is shared by every wallet and reused for every call,
    /// so concurrent calls run one after another. The sync task will continue to run in the background until the sync process is complete.
    /// During this time the main thread will not block but certain wallet methods may temporarily block while the wallet is being written to during the sync.
    /// The sync is performed in bounded steps (see `sync_step`): the wallet lock is released between batches, and
    /// closing the instance with `close` stops the sync at the next batch boundary.
    ///
    /// A trap inside the worker (a Rust panic compiled to wasm) cannot be observed from Rust: the worker stops
    /// taking requests and the trapped call never resolves. The browser surfaces it as an uncaught
    /// `RuntimeError: unreachable` on the window's `error` event, not as a rejection of this promise. JS should
    /// call `report_sync_worker_trap()` from that handler; from then on this call and every later `sync` /
    /// `sync_step` reject with "the sync worker stopped after an internal error; reload the page" instead of
    /// hanging or queueing behind the dead worker.
    ///
    /// # Errors
    ///
    /// Rejects with "the sync worker stopped after an internal error; reload the page" once the worker has been
    /// reported as trapped, with "this wallet instance was closed; reload the wallet" if `close` has been called,
    /// and with a "Syncing Error" for server, cache, scanning and wallet errors.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// await wallet.sync();
    /// ```
    pub async fn sync(&self) -> Result<(), Error> {
        self.run_on_sync_worker(SyncKind::Full).await.map(|_| ())
    }

    /// Perform one bounded step of the sync on the shared sync webworker.
    ///
    /// A step refreshes the wallet's view of the chain tip, then fetches and scans at most one batch of blocks
    /// before releasing the wallet lock, so `db_to_bytes` and other wallet methods can run between steps and the
    /// wallet state at every step boundary can be resumed from later, including from a new page load restored
    /// from `db_to_bytes`. A sync is complete when a step resolves to `false`.
    ///
    /// # Arguments
    ///
    /// * `first` - `true` for the first step of a sync (and after a long pause); the subtree roots are then
    ///   refreshed from the server before scanning. Pass `false` on later steps to skip that round trip.
    ///
    /// # Returns
    ///
    /// `true` if more sync work remains and `sync_step` should be called again, `false` once the wallet reports
    /// nothing left to scan.
    ///
    /// # Errors
    ///
    /// Rejects with "the sync worker stopped after an internal error; reload the page" once the worker has been
    /// reported as trapped (see `report_sync_worker_trap`), with "this wallet instance was closed; reload the
    /// wallet" if `close` has been called, and with a "Syncing Error" for server, cache, scanning and wallet
    /// errors.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// let first = true;
    /// while (await wallet.sync_step(first)) {
    ///   first = false;
    ///   await persist(await wallet.db_to_bytes());
    /// }
    /// ```
    pub async fn sync_step(&self, first: bool) -> Result<bool, Error> {
        self.run_on_sync_worker(SyncKind::Step { first }).await
    }

    /// The id of this wallet instance.
    ///
    /// Every `new WebWallet(...)` gets a fresh id; clones share it. Use it to tell whether a sync step's result
    /// still belongs to the wallet currently in use after the page has swapped in a new instance.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const id = wallet.instance_id;
    /// ```
    #[wasm_bindgen(getter)]
    pub fn instance_id(&self) -> String {
        self.inner.instance_id().to_string()
    }

    /// Close this wallet instance.
    ///
    /// After this, `sync`, `sync_step`, `db_to_bytes`, account creation and every transaction building or
    /// sending method reject with "this wallet instance was closed; reload the wallet". A sync step that is
    /// already running finishes its current batch, and the next step is refused, so a sync loop over this
    /// instance stops at the next batch boundary. Call it before replacing the instance with a new one (for
    /// example on a full resync) so that a step still queued for the old instance cannot write into it.
    /// Closing is idempotent and cannot be undone.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// oldWallet.close();
    /// const wallet = new WebWallet("main", url, 10, 10, bytes);
    /// ```
    pub fn close(&self) {
        self.inner.close();
    }

    /// Whether `close` has been called on this instance.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// if (wallet.is_closed()) { /* reload */ }
    /// ```
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Hand a request to the shared sync worker and wait for its reply.
    ///
    /// Refuses immediately, without queueing, when the worker has been reported as trapped or the instance is
    /// closed. While waiting it also watches the poison signal, so a request that is in flight when the worker
    /// traps is released as soon as JS reports the trap.
    async fn run_on_sync_worker(&self, kind: SyncKind) -> Result<bool, Error> {
        assert!(!thread::is_web_worker_thread());

        if sync_worker_poisoned() {
            return Err(Error::SyncWorkerUnavailable);
        }
        if self.inner.is_closed() {
            return Err(Error::InstanceClosed);
        }

        let (reply, result) = oneshot::channel();
        sync_worker()
            .send(SyncRequest {
                wallet: self.inner.clone(),
                kind,
                reply,
            })
            .map_err(|_| Error::SyncWorkerUnavailable)?;

        let poisoned = sync_worker_poison_signal().notified();
        futures_util::pin_mut!(poisoned);
        match select(result, poisoned).await {
            Either::Left((Ok(Ok(more)), _)) => Ok(more),
            Either::Left((Ok(Err(SyncFailure::InstanceClosed)), _)) => Err(Error::InstanceClosed),
            Either::Left((Ok(Err(SyncFailure::Other(err_string))), _)) => {
                tracing::warn!("Sync error (will be retried by caller): {}", err_string);
                Err(Error::Sync(err_string))
            }
            Either::Left((Err(_), _)) => {
                let msg = "Sync worker dropped the request without replying".to_string();
                tracing::error!("{}", msg);
                Err(Error::Sync(msg))
            }
            Either::Right(((), _)) => Err(Error::SyncWorkerUnavailable),
        }
    }

    pub async fn get_wallet_summary(&self) -> Result<Option<WalletSummary>, Error> {
        Ok(self.inner.get_wallet_summary().await?.map(Into::into))
    }

    /// Create a new transaction proposal to send funds to a given address
    ///
    /// Not this does NOT sign, generate a proof, or send the transaction. It will only craft the proposal which designates how notes from this account can be spent to realize the requested transfer.
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account in this wallet to send funds from
    /// * `to_address` - [ZIP316](https://zips.z.cash/zip-0316) encoded address to send funds to
    /// * `value` - Amount to send in Zatoshis (1 ZEC = 100_000_000 Zatoshis)
    ///
    /// # Returns
    ///
    /// A proposal object which can be inspected and later used to generate a valid transaction
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const proposal = await wallet.propose_transfer(1, "u18rakpts0de589sx9dkamcjms3apruqqax9k2s6e7zjxx9vv5kc67pks2trg9d3nrgd5acu8w8arzjjuepakjx38dyxl6ahd948w0mhdt9jxqsntan6px3ysz80s04a87pheg2mqvlzpehrgup7568nfd6ez23xd69ley7802dfvplnfn7c07vlyumcnfjul4pvv630ac336rjhjyak5", 100000000);
    /// ```
    pub async fn propose_transfer(
        &self,
        account_id: u32,
        to_address: String,
        value: u64,
    ) -> Result<Proposal, Error> {
        let to_address = ZcashAddress::try_from_encoded(&to_address)?;
        let proposal = self
            .inner
            .propose_transfer(AccountId::from(account_id), to_address, value)
            .await?;
        Ok(proposal.into())
    }

    /// Generate a valid Zcash transaction from a given proposal
    ///
    /// IMPORTANT: This will spawn a new webworker which will handle the proving task which may take 10s of seconds
    ///
    /// # Arguments
    ///
    /// * `proposal` - A proposal object generated by `propose_transfer`
    /// * `seed_phrase` - 24 word mnemonic seed phrase. This MUST correspond to the accountID used when creating the proposal.
    /// * `account_hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account. This MUST correspond to the accountID used when creating the proposal.
    ///
    /// # Returns
    ///
    /// A list of transaction IDs which can be used to track the status of the transaction on the network.
    /// It is returned in a flattened form where each ID is 32 bytes.
    /// The transactions themselves are stored within the wallet.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const proposal = await wallet.propose_transfer(1, "u18rakpts0de589sx9dkamcjms3apruqqax9k2s6e7zjxx9vv5kc67pks2trg9d3nrgd5acu8w8arzjjuepakjx38dyxl6ahd948w0mhdt9jxqsntan6px3ysz80s04a87pheg2mqvlzpehrgup7568nfd6ez23xd69ley7802dfvplnfn7c07vlyumcnfjul4pvv630ac336rjhjyak5", 100000000);
    /// const authorized_txns = await wallet.create_proposed_transactions(proposal, "...", 1);
    /// ```
    pub async fn create_proposed_transactions(
        &self,
        proposal: Proposal,
        seed_phrase: &str,
        account_hd_index: u32,
    ) -> Result<Vec<u8>, Error> {
        assert!(!thread::is_web_worker_thread());

        let (usk, _) = usk_from_seed_str(seed_phrase, account_hd_index, &self.inner.network)?;
        let db = self.inner.clone();

        let sync_handler = thread::Builder::new()
            .name("create_proposed_transaction".to_string())
            .spawn_async(|| async move {
                assert!(thread::is_web_worker_thread());
                tracing::debug!(
                    "Current num threads (wasm_thread) {}",
                    rayon::current_num_threads()
                );

                let db = db;
                let txids = db
                    .create_proposed_transactions(proposal.into(), &usk)
                    .await
                    .unwrap_throw();
                return txids;
            })
            .unwrap_throw()
            .join_async();
        let txids = sync_handler.await.map_err(|e| {
            Error::Generic(format!("Transaction creation thread panicked: {:?}", e))
        })?;

        let flattened_txid_bytes = txids.iter().flat_map(|&x| x.as_ref().clone()).collect();
        Ok(flattened_txid_bytes)
    }

    /// Serialize the internal wallet database to bytes
    ///
    /// This should be used for persisting the wallet between sessions. The resulting byte array can be used to construct a new wallet instance.
    /// Note this method is async and will block until a read-lock can be acquired on the wallet database
    ///
    /// # Returns
    ///
    /// A postcard encoded byte array of the wallet database
    ///
    pub async fn db_to_bytes(&self) -> Result<Box<[u8]>, Error> {
        let bytes = self.inner.db_to_bytes().await?;
        Ok(bytes.into_boxed_slice())
    }

    /// Send a list of authorized transactions to the network to be included in the blockchain
    ///
    /// These will be sent via the connected lightwalletd instance
    ///
    /// # Arguments
    ///
    /// * `txids` - A list of transaction IDs (typically generated by `create_proposed_transactions`). It is in flatten form which means it's just a concatination of the 32 byte IDs.
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const proposal = wallet.propose_transfer(1, "u18rakpts0de589sx9dkamcjms3apruqqax9k2s6e7zjxx9vv5kc67pks2trg9d3nrgd5acu8w8arzjjuepakjx38dyxl6ahd948w0mhdt9jxqsntan6px3ysz80s04a87pheg2mqvlzpehrgup7568nfd6ez23xd69ley7802dfvplnfn7c07vlyumcnfjul4pvv630ac336rjhjyak5", 100000000);
    /// const authorized_txns = wallet.create_proposed_transactions(proposal, "...", 1);
    /// await wallet.send_authorized_transactions(authorized_txns);
    /// ```
    pub async fn send_authorized_transactions(&self, txids: Vec<u8>) -> Result<(), Error> {
        let txids = txids
            .chunks(32)
            .map(|txid| {
                let txid_arr: [u8; 32] = txid.try_into().map_err(|_| Error::TxIdParse)?;
                Ok(TxId::from_bytes(txid_arr))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let txids = NonEmpty::from_vec(txids).ok_or(Error::TxIdParse)?;
        self.inner.send_authorized_transactions(&txids).await
    }

    /// Get the current unified address for a given account. This is returned as a string in canonical encoding
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account to get the address for
    ///
    pub async fn get_current_address(&self, account_id: u32) -> Result<String, Error> {
        let db = self.inner.db.read().await;
        if let Some(address) = db.get_last_generated_address_matching(
            account_id.into(),
            UnifiedAddressRequest::ALLOW_ALL,
        )? {
            Ok(address.encode(&self.inner.network))
        } else {
            Err(Error::AccountNotFound(account_id))
        }
    }

    /// Create a Shielding PCZT (Partially Constructed Zcash Transaction).
    ///
    /// A Proposal for shielding funds is created and the the PCZT is constructed for it
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account which transparent funds will be shielded.
    ///
    pub async fn pczt_shield(&self, account_id: u32) -> Result<Pczt, Error> {
        self.inner
            .pczt_shield(account_id.into())
            .await
            .map(Into::into)
    }

    /// Creates a PCZT (Partially Constructed Zcash Transaction).
    ///
    /// A Proposal is created similar to `create_proposed_transactions` and then a PCZT is constructed from it.
    /// Note: This does NOT sign, generate a proof, or send the transaction.
    /// It will only craft the PCZT which designates how notes from this account can be spent to realize the requested transfer.
    /// The PCZT will still need to be signed and proofs will need to be generated before sending.
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account in this wallet to send funds from
    /// * `to_address` - [ZIP316](https://zips.z.cash/zip-0316) encoded address to send funds to
    /// * `value` - Amount to send in Zatoshis (1 ZEC = 100_000_000 Zatoshis)
    ///
    pub async fn pczt_create(
        &self,
        account_id: u32,
        to_address: String,
        value: u64,
    ) -> Result<Pczt, Error> {
        let to_address = ZcashAddress::try_from_encoded(&to_address)?;
        self.inner
            .pczt_create(AccountId::from(account_id), to_address, value)
            .await
            .map(Into::into)
    }

    /// Creates and inserts proofs for a PCZT.
    ///
    /// If there are Sapling spends, a ProofGenerationKey needs to be supplied. It can be derived from the UFVK.
    ///
    /// # Arguments
    ///
    /// * `pczt` - The PCZT that needs to be signed
    /// * `sapling_proof_gen_key` - The Sapling proof generation key (needed only if there are Sapling spends)
    ///
    pub async fn pczt_prove(
        &self,
        pczt: Pczt,
        sapling_proof_gen_key: Option<ProofGenerationKey>,
    ) -> Result<Pczt, Error> {
        self.inner
            .pczt_prove(pczt.into(), sapling_proof_gen_key.map(Into::into))
            .await
            .map(Into::into)
    }

    pub async fn pczt_send(&self, pczt: Pczt) -> Result<(), Error> {
        self.inner.pczt_send(pczt.into()).await
    }

    pub fn pczt_combine(&self, pczts: Vec<Pczt>) -> Result<Pczt, Error> {
        self.inner
            .pczt_combine(pczts.into_iter().map(Into::into).collect())
            .map(Into::into)
    }

    /// Get the current unified address for a given account and extracts the transparent component. This is returned as a string in canonical encoding
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account to get the address for
    ///
    pub async fn get_current_address_transparent(&self, account_id: u32) -> Result<String, Error> {
        let db = self.inner.db.read().await;
        if let Some(address) = db.get_last_generated_address_matching(
            account_id.into(),
            UnifiedAddressRequest::ALLOW_ALL,
        )? {
            Ok(address.transparent().unwrap().encode(&self.inner.network))
        } else {
            Err(Error::AccountNotFound(account_id))
        }
    }

    /// Get transaction history for an account
    ///
    /// # Arguments
    ///
    /// * `account_id` - The ID of the account to get transaction history for
    /// * `limit` - Maximum number of transactions to return (default: 50)
    /// * `offset` - Number of transactions to skip for pagination (default: 0)
    ///
    /// # Returns
    ///
    /// A TransactionHistoryResponse containing the list of transactions, total count, and pagination info
    ///
    /// # Examples
    ///
    /// ```javascript
    /// const history = await wallet.get_transaction_history(0, 50, 0);
    /// console.log(history.transactions);
    /// ```
    pub async fn get_transaction_history(
        &self,
        account_id: u32,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<super::transaction_history::TransactionHistoryResponse, Error> {
        let db = self.inner.db.read().await;
        let chain_tip_height = self
            .inner
            .get_wallet_summary()
            .await
            .ok()
            .flatten()
            .map(|s| s.chain_tip_height().into());

        super::transaction_history::extract_transaction_history(
            &db,
            account_id,
            chain_tip_height,
            limit.unwrap_or(50),
            offset.unwrap_or(0),
        )
    }

    ///////////////////////////////////////////////////////////////////////////////////////
    // lightwalletd gRPC methods
    ///////////////////////////////////////////////////////////////////////////////////////

    ///
    /// Get the highest known block height from the connected lightwalletd instance
    ///
    pub async fn get_latest_block(&self) -> Result<u64, Error> {
        self.client()
            .get_latest_block(ChainSpec {})
            .await
            .map(|response| response.into_inner().height)
            .map_err(Error::from)
    }

    /// Detect the wallet birthday by querying for the first transaction to a transparent address.
    ///
    /// This queries the lightwalletd server for all transactions to the given transparent address
    /// and returns the block height of the earliest transaction, minus a safety buffer.
    ///
    /// # Arguments
    ///
    /// * `transparent_address` - A transparent Zcash address (t-address)
    ///
    /// # Returns
    ///
    /// The detected birthday height, or None if no transactions were found.
    /// Returns the earliest transaction height minus 100 blocks as a safety buffer.
    ///
    pub async fn detect_birthday_from_transparent_address(
        &self,
        transparent_address: &str,
    ) -> Result<Option<u32>, Error> {
        let mut client = self.client();

        // Query from Sapling activation to current tip
        let filter = TransparentAddressBlockFilter {
            address: transparent_address.to_string(),
            range: Some(BlockRange {
                start: Some(BlockId {
                    height: 419200, // Sapling activation height
                    hash: vec![],
                }),
                end: Some(BlockId {
                    height: u64::MAX,
                    hash: vec![],
                }),
                pool_types: vec![], // Empty = all pools
            }),
        };

        let response = client.get_taddress_txids(filter).await?;
        let mut stream = response.into_inner();

        // Find the minimum height from all returned transactions
        let mut min_height: Option<u64> = None;
        while let Some(raw_tx) = stream.try_next().await? {
            let height = raw_tx.height;
            min_height = Some(min_height.map_or(height, |m| m.min(height)));
        }

        // Return with 100-block safety buffer
        Ok(min_height.map(|h| {
            let safe_height = h.saturating_sub(100);
            safe_height as u32
        }))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[wasm_bindgen(inspectable)]
pub struct WalletSummary {
    account_balances: Vec<(u32, AccountBalance)>,
    pub chain_tip_height: u32,
    pub fully_scanned_height: u32,
    // scan_progress: Option<Ratio<u64>>,
    pub next_sapling_subtree_index: u64,
    pub next_orchard_subtree_index: u64,
}

#[wasm_bindgen]
impl WalletSummary {
    #[wasm_bindgen(getter)]
    pub fn account_balances(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.account_balances).unwrap()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountBalance {
    pub sapling_balance: u64,
    pub orchard_balance: u64,
    /// Ironwood pool (NU6.3). Payments to shielded addresses arrive here after the upgrade.
    pub ironwood_balance: u64,
    pub unshielded_balance: u64,
    /// Change from sent transactions waiting for mining confirmation
    pub pending_change: u64,
    /// Received notes waiting for required confirmations to become spendable
    pub pending_spendable: u64,
}

impl From<zcash_client_backend::data_api::AccountBalance> for AccountBalance {
    fn from(balance: zcash_client_backend::data_api::AccountBalance) -> Self {
        AccountBalance {
            sapling_balance: balance.sapling_balance().spendable_value().into(),
            orchard_balance: balance.orchard_balance().spendable_value().into(),
            ironwood_balance: balance.ironwood_balance().spendable_value().into(),
            unshielded_balance: balance.unshielded_balance().spendable_value().into(),
            pending_change: balance.change_pending_confirmation().into(),
            pending_spendable: balance.value_pending_spendability().into(),
        }
    }
}

impl<T> From<zcash_client_backend::data_api::WalletSummary<T>> for WalletSummary
where
    T: std::cmp::Eq + std::hash::Hash + std::ops::Deref<Target = u32> + Clone,
{
    fn from(summary: zcash_client_backend::data_api::WalletSummary<T>) -> Self {
        let mut account_balances: Vec<_> = summary
            .account_balances()
            .iter()
            .map(|(k, v)| (*(*k).clone().deref(), (*v).into()))
            .collect();

        account_balances.sort_by(|a, b| a.0.cmp(&b.0));

        WalletSummary {
            account_balances,
            chain_tip_height: summary.chain_tip_height().into(),
            fully_scanned_height: summary.fully_scanned_height().into(),
            next_sapling_subtree_index: summary.next_sapling_subtree_index(),
            next_orchard_subtree_index: summary.next_orchard_subtree_index(),
        }
    }
}
