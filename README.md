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

REIN sits on top of deterministic smart account guardrails as a subjective semantic supervisor powered by GenLayer. When an agent misbehaves, REIN trustlessly revokes spending authority on-chain.

## Why GenLayer

Deciding whether natural language intent was violated is irreducibly subjective. Yet the outcome of that decision, revoking fund access, must be trustless. The operator cannot veto it, and a rogue dapp cannot forge it.

Subjective judgement paired with trustless, enforceable consequences is the precise reason GenLayer exists.

## Authoritative Live Sources

REIN validators judge actions using five authoritative sources:

1. The natural language mandate committed on-chain at registration time. This is the immutable charter against which every transaction is weighed.
2. Live transaction history pulled independently across block explorers such as Etherscan, Basescan, and Blockscout. Multiple explorers ensure no single API is trusted.
3. Public contract verification status and source code to verify whether the counterparty is legitimate infrastructure or an ephemeral honeypot.
4. Public scam registries and revoked approval registries.
5. Transaction calldata decoded deterministically against verified ABIs before subjective evaluation begins. Decoding is deterministic; intent judgement is semantic.

## Deployed Contracts

The three intelligent contracts are deployed and operational on the GenLayer Studio network:

* MandateRegistry: `0xfC935f8cECe4736577b0f99f14258eaE7cd834d3`
Stores delegation records, natural language mandates, spend limits, and lifecycle states.

* ReinCourt: `0x073903a0C7f46e49b5fD70315f0D1db4E7614414`
The judicial contract. Fetches live explorer data across multiple endpoints, prompts intelligent validators, and enforces comparative consensus.

* Enforcer: `0xA003960cB7cA75E3bC9366715EA941B26Ec4Ad78`
Holds revocation authority. On confirmed breach verdicts, executes revocation, coordinates host chain session key invalidation, and adjudicates bonded appeals.

## The Validator Comparison Rule and Asymmetry

When an action is submitted for review, validators re-fetch transaction data from alternate explorers where possible, decode calldata, and re-run semantic judgement.

Consensus requirements:
* The verdict enum (compliant, breach, ambiguous) must match exactly.
* The breached clause identification must match exactly.
* The severity band (LOW, MED, HIGH, CRITICAL) is tolerated within one adjacent band.
* Agreement on breach versus not breach is strictly mandatory.

Why tolerate a one band difference on severity? Because false revocations are expensive. A minor dispute between LOW and MED should flag an agent for operator review without shutting down active operations. In contrast, an emergency revocation with CRITICAL severity requires strict agreement. Asymmetry protects active agents from accidental halts while ensuring catastrophic malicious breaches are stopped fast.

## Total Value Governed (TVG)

Every unit of spending authority granted under a registered REIN mandate represents value governed by GenLayer. Because the semantic supervisor holds the ultimate power to terminate delegated spending authority on-chain, TVG tracks the aggregate balance and limits protected under active mandates.

## The Appeal Path

When an agent is revoked, the operator can post an on-chain bond and appeal. A fresh validator panel re-examines the mandate, the executed action, and the operator argument.

If overturned:
* Delegation is restored to active status.
* The full bond is returned to the operator.

If upheld:
* The revocation stands.
* The bond is awarded to the watcher who flagged the violation, making continuous supervision economically profitable and self-policing.

## Architecture

```
User / Operator
      │
      ▼
Next.js App (Dashboard, Composer, Timeline)
      │
      ▼
Node Express Relayer (Abstracts gas and tx signing)
      │
      ├───────────────────────┬───────────────────────┐
      ▼                       ▼                       ▼
MandateRegistry          ReinCourt                Enforcer
(On-chain mandates)     (LLM Consensus Judge)   (Revocation & Appeals)
                              │                       │
                              ▼                       ▼
                     Explorer APIs & RPCs     Host Chain Smart Account
                     (Etherscan, Blockscout)  (Revoke session key)
```

## Running the Project

### Prerequisites

* Python 3.10 or higher with pytest
* Node.js 18 or higher with npm

### 1. Contract Tests

Run the full pytest suite:

```bash
python3 -m pytest tests/ -v
```

All 48 unit and integration tests verify registration, status updates, multi-explorer URL resolution, judicial consensus logic, revocation thresholds, and appeal adjudication.

### 2. Backend Relayer and API

Navigate to the backend directory and launch the service:

```bash
cd backend
npm install
node src/server.js
```

The backend connects to Neon PostgreSQL and communicates directly with GenLayer Studio intelligent contracts.

### 3. Frontend Application

Navigate to the frontend directory and start the dev server:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` in your browser. The frontend features:
* Email only sign in via Privy, abstracting wallet management
* The Rein Line structural timeline showing unbroken lines for compliant runs and broken lines on breaches
* Interactive mandate composer with instant preview of hard caps versus semantic coverage
* Dark and light theme switcher with custom monochrome and crimson accents
* Live review console for testing agent actions against on-chain mandates
