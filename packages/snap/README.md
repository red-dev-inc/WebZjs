# WebZjs Zcash Snap

## 🔐 Overview

WebZjs Zcash Snap is a MetaMask Snap that brings Zcash functionality directly into the MetaMask browser extension. WebZjs is the first JavaScript SDK for Zcash, enabling seamless integration of Zcash privacy features for web users.

## 📘 Project Description

Snap uses a Rust library [WebZjs](https://github.com/ChainSafe/WebZjs) compiled to WebAssembly (Wasm). It is meant to be used in conjunction with WebZjs web-wallet.

## 🛠 Prerequisites

[WebZjs](https://github.com/ChainSafe/WebZjs)

- Node.js
- Yarn
- MetaMask Browser Extension (MetaMask Flask for development purposes) [Install MM Flask](https://docs.metamask.io/snaps/get-started/install-flask/)

## 🔨 Development

The snap manifest (`snap.manifest.json`) controls which origins can communicate with the snap via `allowedOrigins`. A script (`scripts/generate-manifest.js`) handles switching between dev and production origins automatically — you should not need to edit the manifest by hand.

### Build Scripts

- **`yarn dev`** / **`yarn start`** - Adds `http://localhost:3000` to `allowedOrigins`, then watches for changes
- **`yarn build`** - Strips any localhost origins from `allowedOrigins` and runs a production build

### Development Steps

1. Install dependencies with `yarn install`
2. For local development: `yarn dev` (automatically adds localhost to allowed origins)
3. For production: `yarn build` (automatically removes localhost from allowed origins)
4. Host snap on localhost http://localhost:8080 with `yarn serve`

### CI: Allowed Origins Check

Two CI workflows (`check-snap-manifest.yml` and `check-snap-allowed-origins.yml`) verify that `snap.manifest.json` on `main` only contains the production origin `["https://webzjs.red.dev"]`. If localhost is present, the check will fail.

**Do not commit `snap.manifest.json` after running `yarn dev`** — it will contain `http://localhost:3000`. Run `yarn build` or `yarn manifest:prod` first to reset it before committing.

## 🔒 Security & Privacy

### UFVK Exposure

The `getViewingKey` RPC returns the wallet's Unified Full Viewing Key (UFVK) to
the requesting web-wallet origin, gated by a per-origin MetaMask consent dialog.
This is used by the view-only web wallet to scan the chain. A UFVK cannot spend
or move funds, but it is a permanent, read-only window into the wallet. Whoever
holds it can see the full balance and the complete transaction history, past and
future. Once shared with an origin (or anything that origin forwards it to), that
visibility cannot be revoked for this wallet. This is a property of the current
design, and reducing UFVK exposure (e.g. keeping scanning inside the Snap) is a
larger architectural change tracked separately.
