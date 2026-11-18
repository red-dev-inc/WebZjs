import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useRef,
} from 'react';

import initWebzJSWallet, {
  initThreadPool,
  WalletSummary,
  WebWallet,
} from '@zcashcommunitygrants/webzjs-wallet';
import initWebzJSKeys from '@zcashcommunitygrants/webzjs-keys';
import { MAINNET_LIGHTWALLETD_PROXY } from '../config/constants';
import { Snap } from '../types';
import toast, { Toaster } from 'react-hot-toast';
import {
  claimWriterRole,
  loadWallet,
  markSuperseded,
  onWalletChanged,
  peekStoredEpoch,
  registerWallet,
  walletOrigin,
} from '../storage/walletStore';

export interface WebZjsState {
  webWallet: WebWallet | null;
  installedSnap: Snap | null;
  error: Error | null | string;
  summary?: WalletSummary;
  chainHeight?: bigint;
  activeAccount?: number | null;
  syncInProgress: boolean;
  loading: boolean;
  initialized: boolean;
  /** Set when stored wallet bytes could not be read; they are kept and backed up, never replaced silently. */
  storedWalletUnreadable: { error: string } | null;
  /** True once this tab holds the single-writer lock and may run periodic syncs. */
  isWriter: boolean;
}

type Action =
  | { type: 'set-web-wallet'; payload: WebWallet }
  | { type: 'set-error'; payload: Error | null | string }
  | { type: 'set-summary'; payload: WalletSummary }
  | { type: 'set-chain-height'; payload: bigint }
  | { type: 'set-active-account'; payload: number }
  | { type: 'set-sync-in-progress'; payload: boolean }
  | { type: 'set-loading'; payload: boolean }
  | { type: 'set-initialized'; payload: boolean }
  | { type: 'set-stored-wallet-unreadable'; payload: { error: string } | null }
  | { type: 'set-writer'; payload: boolean };

const initialState: WebZjsState = {
  webWallet: null,
  installedSnap: null,
  error: null,
  summary: undefined,
  chainHeight: undefined,
  activeAccount: null,
  syncInProgress: false,
  loading: false,
  initialized: false,
  storedWalletUnreadable: null,
  isWriter: false,
};

function reducer(state: WebZjsState, action: Action): WebZjsState {
  switch (action.type) {
    case 'set-web-wallet':
      return { ...state, webWallet: action.payload };
    case 'set-error':
      return { ...state, error: action.payload };
    case 'set-summary':
      return { ...state, summary: action.payload };
    case 'set-chain-height':
      return { ...state, chainHeight: action.payload };
    case 'set-active-account':
      return { ...state, activeAccount: action.payload };
    case 'set-sync-in-progress':
      return { ...state, syncInProgress: action.payload };
    case 'set-loading':
      return { ...state, loading: action.payload };
    case 'set-initialized':
      return { ...state, initialized: action.payload };
    case 'set-stored-wallet-unreadable':
      return { ...state, storedWalletUnreadable: action.payload };
    case 'set-writer':
      return { ...state, isWriter: action.payload };
    default:
      return state;
  }
}

interface WebZjsContextType {
  state: WebZjsState;
  dispatch: React.Dispatch<Action>;
  initWallet: () => Promise<void>;
  /** Replaces the in-memory wallet with what is stored, when storage has moved past it. */
  reloadWallet: () => Promise<void>;
}

const WebZjsContext = createContext<WebZjsContextType>({
  state: initialState,
  dispatch: () => {},
  initWallet: async () => {},
  reloadWallet: async () => {},
});

export function useWebZjsContext(): WebZjsContextType {
  return useContext(WebZjsContext);
}

const decodeWallet = (bytes: Uint8Array | null) =>
  new WebWallet('main', MAINNET_LIGHTWALLETD_PROXY, 1, 1, bytes);

export const WebZjsProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const initializingRef = useRef(false);
  const reloadingRef = useRef(false);
  const writerClaimedRef = useRef(false);
  const walletRef = useRef<WebWallet | null>(null);
  walletRef.current = state.webWallet;

  // Puts a wallet into state with its summary, account and chain height.
  const applyLoadedWallet = useCallback(async (wallet: WebWallet) => {
    dispatch({ type: 'set-web-wallet', payload: wallet });

    const summary = await wallet.get_wallet_summary();
    if (summary) {
      dispatch({ type: 'set-summary', payload: summary });
      if (summary.account_balances.length > 0) {
        dispatch({
          type: 'set-active-account',
          payload: summary.account_balances[0][0],
        });
      }
    }

    try {
      const chainHeight = await wallet.get_latest_block();
      if (chainHeight) {
        dispatch({ type: 'set-chain-height', payload: chainHeight });
      }
    } catch (err) {
      console.warn('Could not fetch chain height on startup (will retry on first sync):', err);
    }
  }, []);

  const initAll = useCallback(async () => {
    try {
      await initWebzJSWallet();
      await initWebzJSKeys();

      try {
        const concurrency = navigator.hardwareConcurrency || 4;
        await initThreadPool(concurrency);
      } catch (err) {
        console.error('Unable to initialize Thread Pool:', err);
        dispatch({
          type: 'set-error',
          payload: new Error('Unable to initialize Thread Pool'),
        });
        return;
      }

      const loaded = await loadWallet(decodeWallet);
      let wallet: WebWallet;
      switch (loaded.status) {
        case 'ok':
          console.info(
            `Saved wallet restored from storage (epoch ${loaded.meta.epoch}${loaded.legacy ? ', legacy format' : ''})`,
          );
          wallet = loaded.wallet;
          break;
        case 'none':
          console.info('No saved wallet detected. Creating new wallet');
          wallet = decodeWallet(null);
          registerWallet(wallet, { epoch: null, birthday: null });
          break;
        case 'unreadable': {
          const error =
            loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
          console.warn('Stored wallet could not be read. It was kept and backed up:', loaded.error);
          toast.error(
            'The saved wallet could not be read. It was kept and backed up; open the home page to recover.',
          );
          // Deliberately not registered: an unregistered instance can never overwrite storage.
          wallet = decodeWallet(null);
          dispatch({ type: 'set-stored-wallet-unreadable', payload: { error } });
          break;
        }
      }

      await applyLoadedWallet(wallet);

      if (!writerClaimedRef.current) {
        writerClaimedRef.current = true;
        claimWriterRole(() => dispatch({ type: 'set-writer', payload: true }));
      }

      dispatch({ type: 'set-loading', payload: false });
      dispatch({ type: 'set-initialized', payload: true });
    } catch (err) {
      console.error('Initialization error:', err);
      dispatch({ type: 'set-error', payload: Error(String(err)) });
      dispatch({ type: 'set-loading', payload: false });
    }
  }, [applyLoadedWallet]);

  // Lazy-load WASM: call this when user wants to use wallet features
  const initWallet = useCallback(async () => {
    if (state.initialized || initializingRef.current) {
      return; // Already initialized or in progress
    }
    initializingRef.current = true;
    dispatch({ type: 'set-loading', payload: true });
    try {
      await initAll();
    } finally {
      initializingRef.current = false;
    }
  }, [state.initialized, initAll]);

  const reloadWallet = useCallback(async () => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    try {
      const current = walletRef.current;
      const storedEpoch = await peekStoredEpoch();
      if (current && walletOrigin(current)?.epoch === storedEpoch) {
        return; // Already current.
      }
      const loaded = await loadWallet(decodeWallet);
      if (loaded.status !== 'ok') {
        if (loaded.status === 'unreadable') {
          const error =
            loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
          dispatch({ type: 'set-stored-wallet-unreadable', payload: { error } });
        }
        return;
      }
      console.info(`Storage moved to epoch ${loaded.meta.epoch}; reloading the wallet from it`);
      if (current) markSuperseded(current);
      dispatch({ type: 'set-stored-wallet-unreadable', payload: null });
      await applyLoadedWallet(loaded.wallet);
    } catch (err) {
      console.error('Could not reload the wallet from storage:', err);
    } finally {
      reloadingRef.current = false;
    }
  }, [applyLoadedWallet]);

  // Follow saves made by other tabs. Background tabs wait until they are visible so they do
  // not decode the wallet on every save the writer makes.
  useEffect(() => {
    let pending = false;
    const onVisible = () => {
      if (pending && document.visibilityState === 'visible') {
        pending = false;
        void reloadWallet();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = onWalletChanged(() => {
      if (document.visibilityState === 'visible') {
        void reloadWallet();
      } else {
        pending = true;
      }
    });
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadWallet]);

  useEffect(() => {
    if (state.error) {
      toast.error(state.error.toString());
    }
  }, [state.error, dispatch]);

  return (
    <WebZjsContext.Provider value={{ state, dispatch, initWallet, reloadWallet }}>
      <Toaster />
      {children}
    </WebZjsContext.Provider>
  );
};
