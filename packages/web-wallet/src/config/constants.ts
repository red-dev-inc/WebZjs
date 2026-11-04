// Zcash network this build targets: 'main' (default) or 'test' (NETWORK=test).
// The Snap MUST target the same network, or derived keys/addresses won't align.
export const NETWORK: 'main' | 'test' =
  process.env.NETWORK === 'test' ? 'test' : 'main';

const MAINNET_PROXY = 'https://zjs.zec.rocks/mainnet';
const TESTNET_PROXY = 'https://zjs.zec.rocks/testnet';

// The lightwalletd gRPC-web proxy for the selected network.
// Override via LIGHTWALLETD_PROXY env var for local dev (e.g. in .env.local).
export const LIGHTWALLETD_PROXY =
  process.env.LIGHTWALLETD_PROXY ||
  (NETWORK === 'test' ? TESTNET_PROXY : MAINNET_PROXY);

// Back-compat alias for existing imports.
export const MAINNET_LIGHTWALLETD_PROXY = LIGHTWALLETD_PROXY;
export const ZATOSHI_PER_ZEC = 1e8;
export const RESCAN_INTERVAL = 35000;          // 35s sync interval
export const NU5_ACTIVATION = 1687104;
