# REIN

"Autonomy is not the same as unsupervised."

The name comes from the simple line you hold on an animal stronger than you. Long enough to let it work, short enough to pull it back before disaster strikes. You do not cage the agent; you hold the rein.

## The Problem With Smart Account Guardrails

AI agents now hold real spending authority on smart accounts through modern delegation standards like ERC 7710, ERC 7715, session keys, and smart wallet permissions.

Every single safety rail available today is deterministic:
* A maximum spend ceiling
* A static allowlist of recipient addresses
* A timestamp expiry

Deterministic numbers cannot say what people actually mean.

Consider what an operator genuinely wants:
"Buy compute for my research, never pay for ads, never send funds to any address created this week, and stop immediately if you suspect you are being socially engineered."

No number or regex can express that. Because operators cannot express intent in raw numbers, they either choke the agent until it becomes useless, or hand it a loose allowance and pray.

Until now, there was no neutral third party capable of reading what the agent did in natural language and ruling whether it breached the mandate. It cannot be the agent itself, and it certainly cannot be the dapp profiting from the transaction.

REIN sits on top of deterministic smart account guardrails as a subjective semantic supervisor powered by GenLayer. When an agent misbehaves, REIN revokes its spending authority on the chain where the money is.

## Why GenLayer

Deciding whether natural language intent was violated is irreducibly subjective. Yet the outcome of that decision, revoking fund access, must be trustless. The operator cannot veto it, and a rogue dapp cannot forge it.

Subjective judgement paired with trustless, enforceable consequences is the precise reason GenLayer exists.

## The Two Halves

REIN is two contracts systems on two chains, and the split matters.

**On GenLayer** live the three intelligent contracts that read, judge and decide. They can reason about natural language and reach consensus on a subjective question, but they cannot sign a transaction on Ethereum.

**On the host chain** lives `ReinSessionKeyRegistry`, an ordinary Solidity contract that holds the authority being governed. A delegator opens a delegation there, escrows the allowance, and names the session key the agent signs with. The agent spends by calling `spend`, which checks on every call that the delegation is still live. One account, the guardian, can flip a delegation to revoked, and that is the whole of its power: it cannot move funds, redirect them, or raise a ceiling.

A revocation is therefore not a status field. It is a state change on the chain holding the money, after which the agent's key still exists and no longer works.

The two halves are tied together by a handle that neither side is told. Both derive it as `keccak256(delegation_id)`, so they cannot be pointed at different delegations.

## What A Review Is Bound To

`review_action` takes a delegation id and a transaction hash. Nothing else.

The mandate text, the agent address and the chain are read from `MandateRegistry` by the court itself. A reviewer cannot supply their own mandate text, cannot point the court at a different chain than the delegation operates on, and cannot attribute another account's transaction to this agent: the court compares the transaction's sender against the registered agent and refuses to judge a mismatch at all.

Each verdict is stored with the agent address and the mandate hash it was decided against, plus the block explorer facts it was decided on. The Enforcer checks those against the registry before acting, so a verdict about a mandate that has since changed cannot be used to revoke.

## Authoritative Live Sources

REIN validators judge actions using evidence, not assertions:

1. The natural language mandate committed on-chain at registration, read from the registry rather than passed in by the caller. This is the immutable charter against which every transaction is weighed, and its keccak256 hash is committed so a later edit is detectable.
2. The transaction as reported by a public block explorer for the registered chain, reduced to the fields that are fixed once a transaction is mined. Volatile fields such as confirmation counts and timestamps are dropped, because validators fetch independently and must compare like with like.
3. Decoded calldata arguments, where the explorer provides them. An approval is only a breach because of its amount; a swap only because of the tokens in its path.
4. The sender, checked against the registered agent before any judgement is attempted.

The submitter's own description of the action is passed to the judge clearly labelled as unverified, and the prompt forbids inferring a breach from it.

## The Validator Comparison Rule and Asymmetry

The leader fetches the transaction, reduces it to stable facts, and judges. Every validator re-derives the attribution from those facts for free, then re-decides the same question on the same evidence and the two answers are compared in code:

* The verdict enum must match exactly. Agreement on breach versus not breach is never relaxed.
* On a breach, both must identify the same clause. Matching is by significant-word overlap, not string equality: two models quoting the same sentence out of a paragraph never produce identical strings, and a rule that demanded they did would reject every real breach while reading as if it were strict.
* The severity band is tolerated within one adjacent band, in both directions.

Why tolerate a one band difference on severity? Because false revocations are expensive, and because a validator that disagrees does not downgrade a band, it rejects the whole verdict. An earlier version of this rule required exact agreement whenever either side said CRITICAL, on the reasoning that an emergency halt should be unanimous. Measured against a real mandate, the leader returned HIGH and the validator CRITICAL on three runs out of three, with an identical verdict and an identical clause, and the rule rejected all three: nothing was recorded, nothing was enforced, and the agent kept spending. Every band from MED upwards triggers the same revocation here, so strictness at CRITICAL bought no safety and vetoed exactly the breaches it was meant to catch. A band dispute now flags an agent for operator review; a dispute two bands wide is still a real disagreement and is still rejected.

There is a second asymmetry, in what a validator checks. Validators are asked for the decision and the band, not for prose: the leader's reasoning is worth having in the audit trail and costs several hundred output tokens, which is more than a validator's execution budget affords. Inventing a breach is therefore checked, because the decision is re-derived. The opposite direction, a leader reporting that nothing could be verified when evidence exists, is not checkable inside that budget, and it fails safe: the verdict becomes ambiguous at confidence 0.1, which the Enforcer refuses to revoke on. The worst case is a review that has to be resubmitted.

## Enforcement Is Two Steps, Deliberately

A breach verdict does not revoke anything by itself.

1. `execute_revocation(verdict_id)` reads the verdict out of ReinCourt by id and checks it reached breach at MED or above, was attributed to the registered agent, and still matches the registered mandate. It records a revocation as `PENDING_HOST_REVOCATION` and flags the mandate. The agent's key still works at this point, and the record says so.
2. The relayer submits `revoke(bytes32,bytes32)` to the session key registry on the host chain.
3. `confirm_host_revocation(revocation_id, evm_tx_hash)` reads that transaction back over JSON-RPC under a strict equivalence principle and requires all of: the receipt exists and succeeded, it was sent to the registry this delegation records, it emitted `DelegationRevoked` for this delegation's handle, and `isActive()` for that handle now answers false. Only then is the revocation `REVOKED`, the transaction hash and block recorded, and the mandate marked revoked.

Nothing here trusts the relayer. The Enforcer derives the event topic, the function selector, the delegation handle and the expected state itself, so a relayer that reported a hash it never sent, or sent one to the wrong contract, simply fails confirmation.

## Total Value Governed (TVG)

Every unit of spending authority granted under a registered REIN mandate represents value governed by GenLayer. Because the semantic supervisor holds the ultimate power to terminate delegated spending authority on-chain, TVG tracks the aggregate balance and limits protected under active mandates.

## The Appeal Path

When an agent is revoked, the operator posts a bond and appeals. The bond is native value sent with the call and escrowed by the Enforcer, not a number recorded in a field.

A fresh validator panel re-examines the registered mandate and the verified block explorer facts the original verdict was reached on. It does not re-examine a description of the action, and it does not re-examine the first judge's reasoning: the operator's argument is given to it as advocacy, and the prompt says that where the argument conflicts with the facts, the facts win.

If upheld:
* The revocation stands.
* The bond is transferred to the watcher who submitted the review, making continuous supervision economically profitable and self-policing.

If overturned:
* The bond is transferred back to whoever paid it.
* The delegation is queued for restoration, and the mandate stays revoked until the host chain `restore` has been submitted and read back by `confirm_host_restoration`, exactly as revocation is. Restoration is reachable from the Enforcer and nowhere else, so an operator cannot lift their own revocation.

## Architecture

```
User / Operator
      │
      ▼
Next.js App (Dashboard, Composer, Timeline)
      │
      ▼
Node Express Relayer (abstracts gas and tx signing)
      │
      ├──────────────── GenLayer ─────────────────┐
      │                                           │
      ▼              ▼                 ▼          │
MandateRegistry  ReinCourt         Enforcer       │
(mandates, the   (LLM consensus    (authenticates │
 only source of   judge; reads      verdicts,     │
 mandate text)    the registry)     holds bonds)  │
      ▲                │                 │        │
      └── status ──────┘                 │ verifies via JSON-RPC
                       │                 │
                       ▼                 ▼
              Block explorers    ReinSessionKeyRegistry (Solidity)
              (Blockscout)       on the host chain:
                                 escrow + session key + revoke/restore
                                          ▲
                                          │ revoke / restore
                                   Relayer (guardian)
```

## Deployed Contracts

GenLayer Studio network:

* MandateRegistry: `0x05218492091D077eb843224D0A4113837380a604`
  Stores delegation records, natural language mandates, spend ceilings, host-chain coordinates and lifecycle state. The only place a mandate is read from.

* ReinCourt: `0x6Ce4415Cb5c90Eba675b40d8Ceb99d183882C9f2`
  The judicial contract. Reads the mandate from the registry, fetches the transaction from a block explorer for the registered chain, checks attribution, and reaches consensus under the comparison rule above.

* Enforcer: `0xd567EE760297Da0a378828ad849Af21A03d1B447`
  Holds revocation authority, authenticates verdicts against the court of record, verifies host-chain effects before recording them, escrows appeal bonds and settles them.

Ethereum Sepolia (host chain, 11155111):

* ReinSessionKeyRegistry: [`0xD20055953d51EFb3612CAc51CfE1d6C29Fd592d5`](https://sepolia.etherscan.io/address/0xD20055953d51EFb3612CAc51CfE1d6C29Fd592d5)
  Holds the delegation, the escrow and the session key. Guardian: `0xBC1399c55538eC034d4Da550C03c34Ae0C357f53`.

Addresses are also written to `deployed_addresses.json` and `backend/.env` by the deploy scripts.

## Running the Project

### Prerequisites

* Python 3.10 or higher with pytest and pycryptodome
* Node.js 18 or higher with npm

### 1. Contract Tests

```bash
python3 -m pytest tests/ -v
```

116 tests. The harness in `tests/conftest.py` is not a mock. It implements the pieces of GenLayer the contracts actually use: `run_nondet` runs the validator against the leader's result so the comparison rule is exercised rather than skipped, `strict_eq` runs the function twice, `get_contract_at` is backed by deployed instances so a cross-contract read reaches the other contract's real code, `message.value` carries a real bond, and transfers are recorded so a payout can be asserted.

### 2. Run the contracts in a real GenVM

```bash
python3.12 -m venv .venv-genvm
.venv-genvm/bin/pip install genlayer-test cloudpickle
.venv-genvm/bin/python -m pytest tests_genvm/ -v
```

These run the contracts in a real local GenVM, which is the only place a
GenVM-level crash produces a traceback. StudioNet reports one as "GenVM crashed
3 times with a non-classifiable internal error" with a memory fingerprint and
nothing else, and settles the transaction as CANCELED with `NO_MAJORITY` and no
receipts at all, which is indistinguishable from validators disagreeing. That
cost real time to work out, so the harness that found it is kept.

It needs Python 3.12 because the GenLayer SDK uses PEP 695 generics, and it
lives outside `tests/` because that directory's conftest installs a fake
`genlayer` module that would shadow the real SDK. Two limits of direct mode are
worth knowing: it patches out the cloudpickle step in `run_nondet`, so the
leader and validator closures are checked for picklability explicitly, and it
allows one contract per process, so the cross-contract read is served through
`vm._gl_call_hook`.

### 3. Lint the intelligent contracts

```bash
genvm-lint check contracts/mandate_registry.py
genvm-lint check contracts/rein_court.py
genvm-lint check contracts/enforcer.py
```

Full SDK validation needs Python 3.12, because the GenLayer SDK uses PEP 695 generics that 3.10 cannot parse. `genvm-lint lint` works on 3.10.

### 4. Host chain contract

```bash
cd backend
npm install
npm run compile:host          # solc 0.8.26 -> src/hostArtifacts.json
npm run deploy:host           # needs HOST_CHAIN_PRIVATE_KEY with testnet funds
node src/verifyHostChain.mjs  # live proof that revocation stops the key
```

`verifyHostChain.mjs` opens a delegation, spends from it, revokes it, shows the same session key reverting, restores it, spends again, and shows a non-guardian revoke reverting. It prints every transaction hash so the run can be audited on a block explorer.

### 5. GenLayer contracts

```bash
cd backend
npm run deploy    # deploys all three and wires the registry to the other two
```

The wiring step matters: without `set_court` and `set_enforcer` the registry sees an unknown caller and rejects revocation and restoration. The script reads the wiring back and refuses to report success if it did not take.

### 6. Backend relayer and API

```bash
cd backend
npm run migrate
npm start
```

`GET /api/health` reports whether the host chain is configured, which is the same thing as whether revocations can be enforced.

### 7. End-to-end verification

```bash
cd backend
node src/verifyWorkflow.mjs
```

Drives the whole workflow against the deployed contracts with nothing stubbed, and reads every result out of contract state rather than trusting a transaction status. A consensus-bearing write that fails to reach a majority is resubmitted, bounded, because that is a property of the network on the day rather than of the request.

### 8. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. The frontend features:
* Email only sign in via Privy, abstracting wallet management
* The Rein Line structural timeline showing unbroken lines for compliant runs and broken lines on breaches
* Interactive mandate composer with instant preview of hard caps versus semantic coverage
* Dark and light theme switcher with custom monochrome and crimson accents
* Live review console for testing agent actions against on-chain mandates
* Revocations shown as flagged until the host chain confirms, with a link to the host-chain transaction

## Notes For Anyone Extending This

A few things are not obvious and cost real time:

* GenLayer can report a transaction as FINALIZED with a successful leader receipt while silently dropping its state writes, if the validators did not agree. Read contract state to confirm a write; never trust the transaction status.
* A validator's execution budget is tighter than the leader's, and prompt cost is dominated by output length, not input length. Asking validators for the leader's full answer times most of them out.
* `delegation_id` is only unique within one registry deployment, so the registry's own address is part of it. Otherwise a redeployed registry restarts its nonce, mints an id whose host-chain handle already exists, and `openDelegation` reverts, leaving a mandate registered but unenforceable.
* ethers v6 passes `eth_estimateGas` through unpadded. A revoke estimated a few hundred gas short lands as a failed transaction, which `confirm_host_revocation` correctly refuses, so it surfaces as a confusing revert. Both the relayer and the verification script pad the estimate.
* ESM evaluates imported modules before the importing module's body, so a module that reads `process.env` at its top level sees the environment before `dotenv.config()` has run. Config here is read at call time.
* Blockscout answers HTTP 200 with an error body for retired endpoints, so a response has to be checked for the transaction it was asked about rather than merely for being non-empty.
* A bare Python exception inside a nondeterministic block is unrecoverable: it takes the VM down rather than failing the call. Anything that parses a model's answer has to raise `[LLM_ERROR]` instead, which makes validators disagree and rotates the leader. `exec_prompt` returning `None` is the usual way in, and `str(None)` is not JSON.
* Calldata cannot encode a Python float, and the leader's return value is calldata-encoded on its way to the validators. Confidence is carried as text for that reason.
* The transaction gas ceiling matters. `review_action` does a cross-contract read, a web fetch and an LLM prompt in one transaction, which exhausts the 5,000,000 that was hardcoded in the relayer. A leader that runs out of gas produces no receipt, so the failure looks like a consensus disagreement rather than a limit.
* Public host-chain RPCs cap `eth_getLogs` at 50,000 blocks and answer a wider request with an error rather than a truncated result, so log scans are windowed from the registry's deploy block.
