/**
 * Zcash network this Snap targets. Defaults to `main`; build with `NETWORK=test` for
 * testnet. The web wallet MUST target the same network or derived keys won't align.
 */
export const NETWORK: 'main' | 'test' =
  process.env.NETWORK === 'test' ? 'test' : 'main';
