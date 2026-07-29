# Deployment Plan - WebZjs Snap (NU6.3 / Ironwood + Spoofing Fix)

>
> _Hosting assumption: this plan assumes **red·bridge** owns and hosts the deployable artifacts
> (npm Snap, web-wallet, gRPC-Web proxy). This responsibility **may shift to ZCG**

---

## 1. Deployable artifacts & how each ships

| Artifact | How it deploys today | Owner action on takeover |
|---|---|---|
| **The Snap** | npm package `@chainsafe/webzjs-zcash-snap` (`snap.manifest.json → source.location.npm`). dApp installs it by npm ID. `yarn snap:build` → `npm publish`. | **Rename to a redbridge npm scope** (e.g. `@red-dev/webzjs-zcash-snap`) + publish under redbridge's npm org. See §4. |
| **Web-wallet** (reference dApp) | Parcel build → Netlify (`netlify.toml`, `.github/workflows/deploy-demo.yml`). | Point at a redbridge domain + Netlify (or other host) account. |
| **gRPC-Web proxy** | `traefik/` config (gRPC-Web → `zec.rocks` mainnet/testnet). ChainSafe hosts one at `zcash-mainnet.chainsafe.dev`. | Stand up a redbridge-hosted instance, or set `LIGHTWALLETD_PROXY`. Not proprietary. |
| **WASM packages** | Build inputs to the Snap/web-wallet (`packages/webzjs-{keys,wallet,requests}`), not separately deployed. | — (built by the recipe). |

**Snap distribution mechanics:**
- MetaMask identifies a Snap by its **npm package id**. Renaming the package = a **different Snap**;
  existing users must install the new one (no silent migration).
- Any source change → new **manifest shasum** → users must **re-approve**. The shasum is finalized
  at the release build (currently left unstaged in dev).
- The dApp selects the Snap via `SNAP_ORIGIN` (`packages/web-wallet/src/config/snap.ts`) —
  `local:http://localhost:8080` in dev, `npm:<package>` in prod.

---

## 2. Environments

| Env | Snap source | Network | Proxy | Purpose |
|---|---|---|---|---|
| **Dev (local)** | `local:http://localhost:8080` (`mm-snap serve`) | main | local traefik / public mainnet proxy | iterate + verify |
| **Mainnet / prod** | published npm (redbridge scope) | main | redbridge/public mainnet proxy | real users |


---

## 3. Staged rollout

### Mainnet production
1. **Publish the Snap** to npm under the redbridge scope (`v1.0.0`).
2. **Deploy the web-wallet** to the production domain, `SNAP_ORIGIN = npm:<redbridge-snap>`, mainnet proxy.
3. **Own the proxy** (redbridge-hosted gRPC-Web → mainnet lightwalletd).
4. Announce: users install the (renamed) Snap and approve the new shasum.
5. **Monitor** (§6). Keep the previous version installable for rollback.

---

## 4. Handover-specific deployment items (redbridge takeover)

These are ownership/identity changes, separate from the code payload:
- **npm scope**: `@chainsafe/webzjs-zcash-snap` → redbridge scope. New package id = **new Snap** to
  MetaMask (users re-install). Requires redbridge npm org + publish credentials.
- **Trusted dApp origin baked into the Snap**: `packages/snap/src/index.tsx:82`
  (`origin === 'https://webzjs.chainsafe.dev'`) and the link in `utils/dialogs.tsx` → redbridge domain.
- **Web-wallet host**: Netlify/GitHub deploy configs (`netlify.toml`, `deploy-demo.yml`) → redbridge
  accounts + domain.
- **lightwalletd proxy**: stand up a redbridge-hosted instance (from `traefik/`) or set the env override.
- **`SNAP_ORIGIN`** default (`web-wallet/src/config/snap.ts`) → the redbridge npm Snap id for prod.
- **Allowed-origins**: review `snap.manifest.json` `endowment:rpc` + `check-snap-allowed-origins` CI.

