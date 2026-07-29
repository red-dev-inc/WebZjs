# Test Cases — Spoofing Fix & Ironwood Migration

Two parts:
- **Part 1** — a plain-English explanation you can read to someone who has *never* seen this
  project (no crypto/Rust background needed).
- **Part 2** — the concrete, numbered test cases. Each says what it checks, how to run it, and
  what "pass" looks like.

For the deeper technical version see `TEST_PLAN_SPOOFING_MIGRATION.md`.

---

## Part 1 — Explaining it to someone with zero context

### The one-sentence version
> We built a safety check that makes the wallet **show you the real transaction and refuse to
> sign a fake or unsafe one**, and we're testing it by feeding it a pile of transactions — some
> honest, some booby-trapped — and confirming it accepts the good ones and rejects the bad ones.

### The analogy (say this out loud)
Imagine you hire an **assistant to sign contracts for you**. A scammer sends over a contract
with a friendly cover note: *"This just pays your friend $10."* But the actual contract inside
says *"Give the scammer $1,000."*

- **The old wallet** signed whatever contract it was handed, trusting the cover note. That's
  called **blind signing** — and it's the bug we fixed.
- **The new wallet** ignores the cover note, **reads the real contract**, shows *you* what it
  actually says, and **refuses to sign** anything that (a) it can't fully read, (b) spends money
  that isn't yours, or (c) doesn't add up.

Two safety layers do this:
- **"Show the truth"** (called *describe*): the wallet reconstructs what the transaction really
  does from the transaction itself — not from the scammer's cover note — and displays it.
- **"Refuse the bad ones"** (called *validate*): a hard gate that blocks anything unsafe before
  signing.

### What "the migration" is
Zcash is adding a **new vault** (called *Ironwood*) alongside the old one (*Orchard*). A
**migration** is simply **moving your money from the old vault into the new vault**. Two things
matter for testing:
1. Moving between vaults happens **in public view**, so the **amount becomes visible on the
   public ledger**. The wallet must **warn you** about this and get your consent.
2. The wallet must confirm the money is going **into your OWN new vault**, not a stranger's. If
   it's going somewhere else, that's a big red flag and the wallet must say so loudly.

### How we test all this (the part they'll actually do)
We pre-made a **collection of transactions** — some honest, some deliberately malicious (a
fake recipient, someone else's money, hidden/unreadable amounts, a migration to a stranger).
Then we wrote a program that **feeds each one to the wallet's safety check and confirms the
reaction is correct**: honest ones get accepted, bad ones get rejected or flagged.

So for the tester, "running the tests" is literally **one command** that plays every scenario
and reports pass/fail. There's also an optional **by-hand** part: look at the actual pop-up the
wallet shows and confirm the warnings appear.

> **The mental model to leave them with:** *"Good transaction in → accepted. Booby-trapped
> transaction in → caught and refused. We have one automated case for each kind of trap."*

---

## Part 2 — The test cases

### Getting the code
All of this lives on the **`main`** branch of the redbridge WebZjs repo. Clone it:
```bash
git clone https://github.com/red-dev-inc/WebZjs.git
cd WebZjs
```
The `zcash_client_memory` fork is pulled in automatically as a git dependency (its own
`feat/snap-nu63` branch) — cargo fetches it on build; you don't check it out by hand. Every
command below assumes you're in the repo root.

### How to run them all (one command)
```bash
cd WebZjs
cargo test -p webzjs-keys
```
**A green run = everything below passed.** Expected: `11 passed, 1 ignored, 0 failed`
(10 behaviour cases + 1 security case; the "ignored" one is the fixture generator, not a test).

### See the full story of each case (recommended)
The command above just prints `... ok` per case. To watch each test **narrate what it did** —
the scenario, the fixture, what the wallet actually read (amounts, recipients, verified/self
flags, the migration summary), and a verdict — add `--nocapture --test-threads=1`:
```bash
cargo test -p webzjs-keys -- --nocapture --test-threads=1
```
Example line you'll see:
```
┌─ CASE  turnstile_migration_end_to_end
│  describe → in 0.00100000 ZEC, out 0.00090000 ZEC, fee 0.00010000 ZEC, 1 output(s)
│    output[0] 0.00090000 ZEC  pool=ironwood  to utest1azjelsv7…a5ta4r  [verified, self]
│    ⇒ MIGRATION recognised: amount 0.00090000 ZEC, to_self=true, clean_path_a=true
│  validate → Ok  (Layer B would allow signing)
└─ ✓ full Orchard→Ironwood migration: in/out/fee correct, self-migration, ACCEPTED
```
This is the easiest way for a newcomer to *see* what's happening. (The narration is
informational; the pass/fail is still decided by the assertions.)

Each case below uses a pre-made transaction (a "fixture"). "Accept" means the wallet would sign
it; "Reject" means it refuses; "Reveal/Flag" means the display surfaces the truth or a warning.

---

### A. Spoofing-fix test cases

| ID | What it checks (plain English) | Setup | Expected result | Backed by |
|----|--------------------------------|-------|-----------------|-----------|
| **SPOOF-01** | An honest payment using only *your* money is allowed. | Honest spend paying a bridge + change back to you. | **Accept.** | `spoof_pczt::honest_pczt_is_accepted` |
| **SPOOF-02** | If a scammer's cover note lies about who gets paid, the wallet shows the **real** recipient. | A fully-consistent transaction that actually pays an attacker. | Display **reveals the attacker's address** (not the claimed one); every line is marked "verified". | `spoof_pczt::spoofed_recipient_is_surfaced` |
| **SPOOF-03** | The wallet won't co-sign a transaction that spends **someone else's** shielded money. | Spends a note that isn't yours. | **Reject.** | `spoof_pczt::foreign_input_is_rejected` |
| **SPOOF-04** | The wallet refuses an output it **can't fully read/verify** (rather than showing a fake "0" and signing). | Output with its secret randomness stripped, so its amount can't be proven. | **Reject.** | `spoof_pczt::unprovable_output_is_refused` |
| **SPOOF-05** | A transparent (non-private) spend of **your own** coin is allowed, and the real recipient is shown. | Spend your transparent coin → pay the bridge. | **Accept**; recipient surfaced. | `spoof_pczt::transparent_input_under_our_key_is_accepted` |
| **SPOOF-06** | The wallet won't co-sign a transparent spend of a coin that isn't yours. | Spend a foreign transparent coin. | **Reject.** | `spoof_pczt::foreign_transparent_input_is_rejected` |
| **SPOOF-07** | "Change coming back to you" is correctly told apart from "a payment going out." | Sapling spend with one payment + one change output. | Display marks one as change, one as payment; **Accept.** | `spoof_pczt::sapling_change_is_detected` |
| **SPOOF-08** | **(HIGH security)** A scammer can't fake ownership by pasting *your* key label onto *someone else's* money. | Foreign spend with your key bytes "planted" on it. | **Reject** as foreign; that money is **not** counted as yours. | `security_finding1::fvk_plant_does_not_bypass_foreign_input_detection` |
| **SPOOF-09** | *(By hand)* If the site claims a different **amount** than the transaction really sends, the pop-up warns. | Any transaction where claimed amount ≠ real amount. | Dialog shows a **⚠ amount-mismatch warning**. | Manual — `signPczt.tsx` |
| **SPOOF-10** | *(By hand)* If the site claims a different **recipient**, the pop-up asks you to confirm the real one. | Any transaction where claimed recipient ≠ real recipient. | Dialog shows a **confirm-recipient prompt**. | Manual — `signPczt.tsx` |

---

### B. Ironwood-migration test cases

| ID | What it checks (plain English) | Setup | Expected result | Backed by |
|----|--------------------------------|-------|-----------------|-----------|
| **MIG-01** | A transaction that puts money into the new vault is read correctly and, if honest, allowed. | Ironwood transaction paying the bridge 90k, fee 10k. | Display shows an **"ironwood" output, verified**; **Accept.** | `spoof_pczt::ironwood_payment_is_described_and_accepted` |
| **MIG-02** | If the migration sends money to **someone else's** vault, it's flagged (not silently signed). | Same as MIG-01 (pays the bridge, a foreign address). | Recognised as a migration but **`to_self = false`** → dialog must warn loudly. | `spoof_pczt::ironwood_payment_is_described_and_accepted` |
| **MIG-03** | A migration into **your own** vault is recognised as a clean, safe self-migration. | Ironwood output paying **your own** address. | **`to_self = true`, `is_clean_path_a = true`.** | `spoof_pczt::self_migration_is_recognized` |
| **MIG-04** | The **real** migration shape works end-to-end: money leaves the old vault and enters the new one in one transaction, with the right fee. | Orchard spend 100k → single Ironwood output 90k to you, 10k fee. | In = 100k, Out = 90k, Fee = 10k; recognised as self-migration; **Accept.** | `spoof_pczt::turnstile_migration_end_to_end` |
| **MIG-05** | *(By hand)* The migration pop-up shows the **public-amount warning** and the **self/not-self** status. | Any migration transaction. | Dialog leads with "Migrate to Ironwood", the amount, the **"revealed publicly on-chain" warning**, and ✓ self or ⚠ not-self. | Manual — `signPczt.tsx` |

---

### C. Known gaps (tell the tester these are NOT covered yet)
- Signing an *Ironwood* spend end-to-end (only Orchard spends are signature-tested; the code
  path for Ironwood is identical and compile-checked).
- The wallet **detecting incoming** Ironwood funds (scanning) — not built yet.
- A full **live browser** run in MetaMask against a test network — needs extra infrastructure.
- Two lower-severity display checks (fee-inflation, over-precise amount) are currently verified
  by **code review**, not an automated case.

---

## Quick reference — the whole thing in 4 lines
1. **Spoofing fix = "show the real transaction, refuse the bad ones."** Tested by feeding
   honest + booby-trapped transactions and checking accept/reject.
2. **Migration = "move money to the new vault; warn that the amount goes public; confirm it's
   your own vault."**
3. **To run it all:** `cargo test -p webzjs-keys` → expect `11 passed, 0 failed`.
4. **Green = safe.** Each red would name exactly which trap the wallet stopped catching.
