import type { SnapConfig } from '@metamask/snaps-cli';
import { resolve } from 'path';

const config: SnapConfig = {
  bundler: 'webpack',
  customizeWebpackConfig: (config) => {
    config.module?.rules?.push({
      test: /\.wasm$/,
      type: 'asset/inline',
    });
    return config;
  },
  input: resolve(__dirname, 'src/index.tsx'),
  // Injected into the bundle at build time. NETWORK selects main/testnet derivation;
  // build with `NETWORK=test` to target testnet (must match the web wallet's build).
  environment: {
    NETWORK: process.env.NETWORK ?? 'main',
  },
  server: {
    port: 8080,
  },
  polyfills: {
    buffer: true,
  },
};

export default config;
