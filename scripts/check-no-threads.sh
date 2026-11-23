#!/usr/bin/env bash
# Checks that the `no-threads` flavour of webzjs-wallet needs no threads.
#
#   scripts/check-no-threads.sh              feature graph only (no build needed)
#   scripts/check-no-threads.sh <file.wasm>  also inspects a built wasm (needs `wasm-tools`)
#
# Graph: with `wasm no-threads`, wasm_thread and wasm-bindgen-rayon are not in the dependency graph and no
# crate enables a thread-pool feature (multicore, threads, web_spin_lock, rayon).
# (The rayon crate itself stays: zcash_client_backend depends on it unconditionally.)
# Wasm: validates with the threads proposal off (no shared memory, no atomic instructions), so the module
# needs no SharedArrayBuffer.
set -euo pipefail

wasm=""
[ "$#" -ge 1 ] && wasm=$(realpath "$1")
cd "$(dirname "$0")/../crates/webzjs-wallet"
fail=0
tree() { cargo tree ${CARGO_TREE_FLAGS:-} --target wasm32-unknown-unknown --no-default-features --features "${FEATURES:-wasm no-threads}" -e features "$@"; }

tree >/dev/null || { echo "FAIL: cannot resolve the graph with features '${FEATURES:-wasm no-threads}'"; exit 1; }

for pkg in wasm_thread wasm-bindgen-rayon; do
  if tree -i "$pkg" >/dev/null 2>&1; then echo "FAIL: $pkg is in the no-threads graph"; fail=1; fi
done
# No crate may switch on a thread-pool feature (multicore, maybe-rayon/threads, rayon/web_spin_lock, ...).
bad=$(tree --prefix none | grep -E ' feature "(multicore|threads|web_spin_lock|rayon)"' | sort -u || true)
if [ -n "$bad" ]; then echo "FAIL: thread features enabled:"; echo "$bad"; fail=1; fi

if [ "$#" -ge 1 ]; then
  command -v wasm-tools >/dev/null || { echo "FAIL: wasm-tools not installed"; exit 1; }
  # With the threads proposal off, validation rejects shared memory and every atomic instruction (incl. atomic.fence).
  if ! err=$(wasm-tools validate --features=-threads "$wasm" 2>&1); then
    echo "FAIL: $wasm needs the wasm threads proposal (shared memory or atomics): $(head -n 3 <<<"$err" | tr '\n' ' ')"; fail=1
  fi
fi

[ "$fail" -eq 0 ] && echo "OK: no-threads checks passed"
exit "$fail"
