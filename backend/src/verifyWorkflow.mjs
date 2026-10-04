/**
 * End-to-end verification against the deployed contracts.
 *
 * Drives the whole workflow on StudioNet and the host chain, with nothing
 * stubbed: register a mandate, review a transaction the agent really sent,
 * revoke on a breach verdict, prove the host chain stopped the key, appeal with
 * a real bond, and settle it.
 *
 * Every step reads its result out of contract state rather than trusting a
 * transaction status, because GenLayer has been observed reporting CANCELED for
 * transactions whose writes did land.
 *
 * Usage: node src/verifyWorkflow.mjs [--from <step>]
 */

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import dotenv from "dotenv";
dotenv.config();

import {
  readContract,
  writeContract,
  getRelayerBalance,
  relayerAddress,
  txOutcome,
} from "./genlayerRelayer.js";
import {
  delegationHandle,
  hostChainInfo,
  isActive as hostIsActive,
  openDelegation as hostOpenDelegation,
  restoreDelegation as hostRestoreDelegation,
  revokeDelegation as hostRevokeDelegation,
  hostRegistryAddress,
} from "./hostChain.js";

const REGISTRY = process.env.MANDATE_REGISTRY_ADDRESS;
const COURT = process.env.REIN_COURT_ADDRESS;
const ENFORCER = process.env.ENFORCER_ADDRESS;

// A transaction the agent below really sent on Sepolia: the session key calling
// spend() on ReinSessionKeyRegistry. Judged against a mandate it breaches.
const AGENT = "0xdC81c69F8D9DE93349Ac9Def1454eabB1D3D58dc";
const SESSION_KEY = AGENT;
const DELEGATOR = relayerAddress();
const CHAIN = "11155111";
const ACTION_TX = "0xb48189b604afec8bcc8c6fc90223e5a6ef4d38714b48ac52deaddfc26cda88a4";

const MANDATE =
  "Buy research compute only. Only ever transact with the approved vendor " +
  "contract at 0x1111111111111111111111111111111111111111. Never send a " +
  "transaction to any other contract or address. Never pay for advertising.";

const BOND_WEI = 10n ** 16n;
// StudioNet allows 500 RPC requests per hour across the whole client. A full
// run of this script makes several long waits, and polling every ten seconds
// exhausts the budget partway through and then fails every remaining call with
// -32029 for the rest of the window.
const POLL_MS = Number(process.env.VERIFY_POLL_MS || 20000);
const CONSENSUS_BUDGET_MS = 420000;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for contract state to show something, optionally giving up early.
 *
 * `watchTx` is the transaction expected to produce it. GenLayer consensus can
 * fail: a transaction whose validators never reach a majority settles as
 * CANCELED with result_name NO_MAJORITY, and its state writes are discarded.
 * From contract state alone that is indistinguishable from "still running", so
 * without this the script waits out its whole budget on a transaction that is
 * already dead.
 */
async function until(label, read, predicate, { budgetMs = CONSENSUS_BUDGET_MS, watchTx } = {}) {
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const value = await read().catch(() => null);
    const hit = predicate(value);
    if (hit) return hit === true ? value : hit;

    if (watchTx) {
      const outcome = await txOutcome(watchTx);
      if (outcome.failed) {
        const err = new Error(
          `${label}: GenLayer did not reach a majority (${outcome.reason}); ` +
            `the transaction settled as ${outcome.status} and its writes were discarded`
        );
        err.consensusFailed = true;
        throw err;
      }
    }

    const left = Math.round((deadline - Date.now()) / 1000);
    log(`    waiting for ${label}... (attempt ${attempts}, ${left}s left)`);
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Submit a consensus-bearing write and wait for its effect, retrying if the
 * network fails to agree. Consensus failure is a property of the network on the
 * day rather than of the request, so a retry is usually the difference between
 * a result and a dead run.
 */
async function submitAndSettle(label, send, read, predicate, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const txHash = await send();
    log(`   tx: ${txHash}${i > 1 ? ` (attempt ${i})` : ""}`);
    try {
      return { value: await until(label, read, predicate, { watchTx: txHash }), txHash };
    } catch (err) {
      if (!err.consensusFailed || i === attempts) throw err;
      lastErr = err;
      log(`   ${err.message}`);
      log(`   retrying ${label} (${i + 1} of ${attempts})`);
    }
  }
  throw lastErr;
}

async function main() {
  if (!REGISTRY || !COURT || !ENFORCER) {
    throw new Error("Contract addresses are not set in .env");
  }

  log("REIN end-to-end verification");
  log("============================");
  log(`MandateRegistry: ${REGISTRY}`);
  log(`ReinCourt:       ${COURT}`);
  log(`Enforcer:        ${ENFORCER}`);
  log(`Host chain:      ${JSON.stringify(hostChainInfo())}`);
  log(`Relayer:         ${relayerAddress()}`);
  log(`Relayer balance: ${await getRelayerBalance()} wei\n`);

  const wiring = await readContract(REGISTRY, "get_wiring", []);
  log(`0. Registry wiring: ${JSON.stringify(wiring)}`);
  if (wiring.enforcer?.toLowerCase() !== ENFORCER.toLowerCase()) {
    throw new Error("registry is not wired to this enforcer");
  }

  // ---- 1. register ---------------------------------------------------------
  log("\n1. Registering the mandate");
  const { txHash: regTx } = await writeContract(
    REGISTRY,
    "register_mandate",
    [DELEGATOR, AGENT, MANDATE, "1000000000000000", CHAIN, SESSION_KEY, hostRegistryAddress()],
    { requireFinality: false, budgetMs: 0 }
  );
  log(`   tx: ${regTx}`);
  const mandate = await until(
    "the mandate to appear on chain",
    () => readContract(REGISTRY, "get_all_mandates", []),
    (all) =>
      Array.isArray(all)
        ? all.filter((m) => m?.mandate_text === MANDATE).pop() || false
        : false
  );
  const delegationId = mandate.delegation_id;
  log(`   delegation_id:      ${delegationId}`);
  log(`   mandate_hash:       ${mandate.mandate_hash}`);
  log(`   host_delegation_id: ${mandate.host_delegation_id}`);
  log(`   derived locally:    ${delegationHandle(delegationId)}`);
  if (mandate.host_delegation_id !== delegationHandle(delegationId)) {
    throw new Error("host handle derivation disagrees across the two chains");
  }
  if (mandate.status !== "ACTIVE") throw new Error(`unexpected status ${mandate.status}`);

  // ---- 2. open the host-chain delegation ----------------------------------
  log("\n2. Opening the matching delegation on the host chain");
  const opened = await hostOpenDelegation({
    delegationId,
    agentAddress: AGENT,
    sessionKey: SESSION_KEY,
    ceilingWei: "1000000000000000",
    escrowWei: "0",
  });
  log(`   tx: ${opened.hash} (mined=${opened.mined} status=${opened.status})`);
  log(`   host isActive: ${await hostIsActive(delegationId)}`);

  // ---- 3. review -----------------------------------------------------------
  log("\n3. Submitting the agent's transaction for review");
  log(`   action tx: ${ACTION_TX}`);
  const { value: verdict } = await submitAndSettle(
    "the verdict to reach consensus",
    async () =>
      (
        await writeContract(
          COURT,
          "review_action",
          [delegationId, ACTION_TX, "Bought GPU time from the approved vendor"],
          { requireFinality: false, budgetMs: 0 }
        )
      ).txHash,
    () => readContract(COURT, "get_verdict_for_action", [delegationId, ACTION_TX]),
    (v) => (v && v.verdict_id ? v : false)
  );
  log(`   verdict_id:   ${verdict.verdict_id}`);
  log(`   verdict:      ${verdict.verdict} / ${verdict.severity}`);
  log(`   attributed:   ${verdict.attributed}`);
  log(`   clause:       ${verdict.breached_clause}`);
  log(`   confidence:   ${verdict.confidence}`);
  log(`   agent bound:  ${verdict.agent_address}`);
  log(`   mandate hash: ${verdict.mandate_hash}`);
  log(`   facts:        ${String(verdict.facts).slice(0, 220)}`);
  log(`   reasoning:    ${String(verdict.reasoning).slice(0, 300)}`);

  if (verdict.agent_address?.toLowerCase() !== AGENT.toLowerCase()) {
    throw new Error("verdict was not bound to the registered agent");
  }
  if (verdict.mandate_hash !== mandate.mandate_hash) {
    throw new Error("verdict was not bound to the registered mandate");
  }
  if (!verdict.attributed) {
    throw new Error("the court did not attribute the transaction to the agent");
  }

  if (verdict.verdict !== "breach" || verdict.severity === "LOW") {
    log(
      `\n   The panel returned ${verdict.verdict}/${verdict.severity}, which is ` +
        `not enforceable. Checking the enforcer refuses it, then stopping.`
    );
    try {
      await writeContract(ENFORCER, "execute_revocation", [verdict.verdict_id], {
        requireFinality: true,
        budgetMs: 120000,
      });
      throw new Error("the enforcer accepted an unenforceable verdict");
    } catch (err) {
      log(`   enforcer refused it, as it should: ${err.message.slice(0, 160)}`);
    }
    return;
  }

  // ---- 4. revoke -----------------------------------------------------------
  log("\n4. Acting on the stored verdict");
  const { txHash: revTx } = await writeContract(
    ENFORCER,
    "execute_revocation",
    [verdict.verdict_id],
    { requireFinality: false, budgetMs: 0 }
  );
  log(`   tx: ${revTx}`);
  const revocation = await until(
    "the revocation to be recorded",
    () => readContract(ENFORCER, "get_revocation_by_verdict", [verdict.verdict_id]),
    (r) => (r && r.revocation_id ? r : false)
  );
  log(`   revocation_id:  ${revocation.revocation_id}`);
  log(`   status:         ${revocation.status}`);
  log(`   evm_tx_hash:    "${revocation.evm_tx_hash}"`);
  log(`   watcher:        ${revocation.watcher}`);
  log(`   host_registry:  ${revocation.host_registry}`);
  log(`   host handle:    ${revocation.host_delegation_id}`);
  if (revocation.status !== "PENDING_HOST_REVOCATION") {
    throw new Error(`expected PENDING_HOST_REVOCATION, got ${revocation.status}`);
  }
  if (revocation.evm_tx_hash !== "") {
    throw new Error("a revocation claimed a host transaction before one was sent");
  }
  log(`   host isActive (still live, as it must be): ${await hostIsActive(delegationId)}`);

  // ---- 5. host-chain revocation -------------------------------------------
  log("\n5. Submitting the host-chain revocation");
  const hostRev = await hostRevokeDelegation({
    delegationId,
    verdictId: verdict.verdict_id,
  });
  log(`   tx: ${hostRev.hash} (mined=${hostRev.mined} status=${hostRev.status})`);
  if (hostRev.status !== 1) throw new Error("host revoke did not succeed");
  log(`   host isActive: ${await hostIsActive(delegationId)}`);

  // ---- 6. confirm ----------------------------------------------------------
  log("\n6. Having the Enforcer read the receipt back");
  const { txHash: confirmTx } = await writeContract(
    ENFORCER,
    "confirm_host_revocation",
    [revocation.revocation_id, hostRev.hash],
    { requireFinality: false, budgetMs: 0 }
  );
  log(`   tx: ${confirmTx}`);
  const confirmed = await until(
    "the revocation to be confirmed",
    () => readContract(ENFORCER, "get_revocation", [revocation.revocation_id]),
    (r) => (r && r.status === "REVOKED" ? r : false)
  );
  log(`   status:           ${confirmed.status}`);
  log(`   evm_tx_hash:      ${confirmed.evm_tx_hash}`);
  log(`   evm_block_number: ${confirmed.evm_block_number}`);
  if (confirmed.evm_tx_hash !== hostRev.hash.toLowerCase()) {
    throw new Error("the recorded transaction is not the one that was sent");
  }

  log("\n7. The registry should now report the delegation as revoked");
  const revokedMandate = await until(
    "the registry status to settle",
    () => readContract(REGISTRY, "get_mandate", [delegationId]),
    (m) => (m && m.status === "REVOKED" ? m : false),
    { budgetMs: 420000 }
  );
  log(`   status:       ${revokedMandate.status}`);
  log(`   action_count: ${revokedMandate.action_count}`);
  log(`   is_live:      ${await readContract(REGISTRY, "is_live", [delegationId])}`);

  // ---- 8. appeal -----------------------------------------------------------
  log("\n8. Filing a bonded appeal");
  const beforeBond = await readContract(ENFORCER, "get_bond_balance", []);
  const { txHash: appealTx } = await writeContract(
    ENFORCER,
    "file_appeal",
    [
      revocation.revocation_id,
      "0xD20055953d51EFb3612CAc51CfE1d6C29Fd592d5 is the REIN session key " +
        "registry itself, which is the only route the agent has to reach the " +
        "approved vendor. Transacting with it is how the mandate is obeyed, " +
        "not a breach of it.",
    ],
    { requireFinality: false, budgetMs: 0, value: BOND_WEI }
  );
  log(`   tx: ${appealTx}`);
  const appeal = await until(
    "the appeal to be recorded",
    () => readContract(ENFORCER, "get_all_appeals", []),
    (all) =>
      Array.isArray(all)
        ? all.filter((a) => a?.revocation_id === revocation.revocation_id).pop() || false
        : false
  );
  log(`   appeal_id:  ${appeal.appeal_id}`);
  log(`   bond_wei:   ${appeal.bond_wei}`);
  log(`   appellant:  ${appeal.appellant}`);
  log(`   watcher:    ${appeal.watcher}`);
  const afterBond = await readContract(ENFORCER, "get_bond_balance", []);
  log(`   contract bond balance: ${beforeBond} -> ${afterBond}`);
  if (BigInt(appeal.bond_wei) !== BOND_WEI) {
    throw new Error(`the escrowed bond is ${appeal.bond_wei}, not ${BOND_WEI}`);
  }
  if (BigInt(afterBond) - BigInt(beforeBond) !== BOND_WEI) {
    throw new Error("the contract did not actually take custody of the bond");
  }

  // ---- 9. adjudicate -------------------------------------------------------
  log("\n9. Re-deciding on the verified action");
  const { value: decided } = await submitAndSettle(
    "the appeal to be decided",
    async () =>
      (
        await writeContract(ENFORCER, "adjudicate_appeal", [appeal.appeal_id], {
          requireFinality: false,
          budgetMs: 0,
        })
      ).txHash,
    () => readContract(ENFORCER, "get_appeal", [appeal.appeal_id]),
    (a) => (a && ["UPHELD", "OVERTURNED"].includes(a.status) ? a : false)
  );
  log(`   status:           ${decided.status}`);
  log(`   bond_settlement:  ${decided.bond_settlement}`);
  log(`   bond_paid_to:     ${decided.bond_paid_to}`);
  log(`   reasoning:        ${String(decided.adjudication_result).slice(0, 300)}`);

  if (decided.status === "UPHELD") {
    if (decided.bond_settlement !== "AWARDED_TO_WATCHER") {
      throw new Error(`upheld appeal settled as ${decided.bond_settlement}`);
    }
    log(`   The revocation stands and the bond went to the watcher.`);
    log(`   host isActive: ${await hostIsActive(delegationId)}`);
    log("\nVerification complete: breach -> revocation -> upheld appeal.");
    return;
  }

  if (decided.bond_settlement !== "RETURNED_TO_APPELLANT") {
    throw new Error(`overturned appeal settled as ${decided.bond_settlement}`);
  }
  if (decided.restoration_status !== "PENDING_HOST_RESTORE") {
    throw new Error(`expected PENDING_HOST_RESTORE, got ${decided.restoration_status}`);
  }
  log(`   Bond returned, restoration pending. Delegation is still revoked:`);
  log(`   registry status: ${(await readContract(REGISTRY, "get_mandate", [delegationId])).status}`);
  log(`   host isActive:   ${await hostIsActive(delegationId)}`);

  // ---- 10. restore ---------------------------------------------------------
  log("\n10. Restoring on the host chain, then confirming");
  const hostRestore = await hostRestoreDelegation({
    delegationId,
    appealId: appeal.appeal_id,
  });
  log(`   tx: ${hostRestore.hash} (status=${hostRestore.status})`);
  log(`   host isActive: ${await hostIsActive(delegationId)}`);

  const { txHash: confirmRestoreTx } = await writeContract(
    ENFORCER,
    "confirm_host_restoration",
    [appeal.appeal_id, hostRestore.hash],
    { requireFinality: false, budgetMs: 0 }
  );
  log(`   tx: ${confirmRestoreTx}`);
  const restored = await until(
    "the restoration to be confirmed",
    () => readContract(ENFORCER, "get_appeal", [appeal.appeal_id]),
    (a) => (a && a.restoration_status === "RESTORED" ? a : false)
  );
  log(`   restoration_status:   ${restored.restoration_status}`);
  log(`   restoration_tx_hash:  ${restored.restoration_tx_hash}`);

  const finalMandate = await until(
    "the registry to report RESTORED",
    () => readContract(REGISTRY, "get_mandate", [delegationId]),
    (m) => (m && m.status === "RESTORED" ? m : false),
    { budgetMs: 420000 }
  );
  log(`   registry status: ${finalMandate.status}`);
  log(`   host isActive:   ${await hostIsActive(delegationId)}`);

  log("\nVerification complete: breach -> revocation -> overturned appeal -> restoration.");
}

main().catch((err) => {
  console.error("\nVERIFICATION FAILED:", err.message ?? err);
  process.exit(1);
});
