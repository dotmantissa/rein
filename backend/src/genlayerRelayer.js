/**
 * GenLayer Relayer for REIN
 *
 * Handles all interactions between the Node.js backend and the GenLayer
 * Intelligent Contracts. Abstracts transaction signing, submission, polling,
 * and contract reads so the API routes never touch raw RPC.
 */

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import { createClient, chains } from "genlayer-js";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { ethers } from "ethers";

// Read at call time, not at import. ESM evaluates imported modules before the
// importing module's body, so anything captured here would be read before a
// script's own dotenv.config() had run -- which is exactly how a correctly
// configured .env produced "GENLAYER_PRIVATE_KEY not configured".
// Gas ceiling for a GenLayer transaction.
//
// StudioNet prices gas at zero, so a generous ceiling costs nothing, and the
// old 5,000,000 was not generous enough for `review_action`: a cross-contract
// read, a web fetch and an LLM prompt in one transaction exhausted it. A leader
// that runs out of gas produces no receipt at all, so the transaction came back
// with zero leader receipts, zero validator receipts, three recovery cycles and
// `NO_MAJORITY` -- which reads exactly like a disagreement, and sent the
// investigation after the comparison rule instead of the limit.
const GAS_LIMIT = process.env.GENLAYER_GAS_LIMIT || "0x5F5E100"; // 100,000,000

const rpcUrl = () => process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
const deployer = () =>
  process.env.GENLAYER_DEPLOYER_ADDRESS ||
  "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53";
const privKey = () => process.env.GENLAYER_PRIVATE_KEY;

// StudioNet rate-limits a client to 500 RPC requests per hour. Polling every
// three seconds spends 1200 an hour on a single waiting request, which exhausts
// the budget and then fails every call with -32029 for the rest of the window.
// Ten seconds keeps a long wait affordable.
const pollMs = () => Number(process.env.GENLAYER_POLL_MS || 10000);

// How long a single request may spend waiting for consensus. On a long-running
// host this can be generous; on a serverless host it must stay inside the
// platform's function ceiling or the caller gets a 504 with no tx hash to
// recover from. Bounded by wall clock, not poll count, so tuning POLL_MS can
// never change the worst-case request duration.
const finalityBudgetMs = () =>
  Number(process.env.GENLAYER_FINALITY_BUDGET_MS || 240000);

async function rpc(method, params = []) {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

function getProvider() {
  const key = privKey();
  if (!key) throw new Error("GENLAYER_PRIVATE_KEY not configured");
  const wallet = new ethers.Wallet(key);

  return {
    async request({ method, params = [] }) {
      if (method === "eth_sendTransaction") {
        const tx = params[0];
        const nonce = await rpc("eth_getTransactionCount", [
          deployer(),
          "latest",
        ]);
        const chainId = await rpc("eth_chainId", []);
        // tx.value matters here. The appeal bond is escrowed from
        // gl.message.value, so dropping it would leave the contract rejecting
        // every appeal as underfunded while the relayer reported it as sent.
        const signed = await wallet.signTransaction({
          to: tx.to ?? null,
          data: tx.data,
          value: tx.value ?? "0x0",
          gas: tx.gas ?? GAS_LIMIT,
          gasPrice: tx.gasPrice ?? "0x0",
          nonce,
          chainId: parseInt(chainId, 16),
        });
        return rpc("eth_sendRawTransaction", [signed]);
      }
      if (method === "eth_estimateGas") return GAS_LIMIT;
      return rpc(method, params);
    },
  };
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient({
      chain: chains.studionet,
      endpoint: rpcUrl(),
      account: deployer(),
      provider: getProvider(),
    });
  }
  return _client;
}

export async function pollTxFinality(hash, { budgetMs } = {}) {
  if (budgetMs === undefined) budgetMs = finalityBudgetMs();
  // A zero budget means the caller only wanted the transaction broadcast and
  // will confirm the outcome by reading contract state instead.
  if (budgetMs <= 0) return { status: "submitted", rawStatus: "SUBMITTED" };
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(pollMs(), Math.max(0, deadline - Date.now())))
    );
    try {
      const tx = await rpc("eth_getTransactionByHash", [hash]).catch(
        () => null
      );
      if (!tx) continue;
      const raw = tx.status;
      let statusName = null;
      if (typeof raw === "string") {
        statusName = raw === "ACTIVATED" ? "PENDING" : raw;
      } else if (typeof raw === "number") {
        statusName = transactionsStatusNumberToName[String(raw)] || null;
      }
      if (["FINALIZED", "ACCEPTED"].includes(statusName)) {
        return { status: "finalized", rawStatus: statusName, tx };
      }
      if (statusName === "CANCELED") {
        return { status: "failed", rawStatus: statusName, tx };
      }
    } catch {
      // Transient network issue, retry
    }
  }
  return { status: "timeout", rawStatus: "TIMEOUT" };
}

/**
 * Write to a GenLayer contract and wait for finality.
 *
 * `budgetMs` caps the wait. If consensus has not landed by then the behaviour
 * depends on `requireFinality`: the default throws (callers that cannot act on
 * a half-finished write), while `false` returns the broadcast hash with a
 * non-finalized status so the caller can persist it and reconcile later. The
 * transaction is already on the network either way — only our patience ran out.
 *
 * `value` carries native tokens with the call. The appeal bond is the only
 * caller that needs it, and it needs it to be real: the Enforcer reads
 * gl.message.value and escrows exactly that, so a bond that was not actually
 * sent is a bond the contract will refuse.
 */
export async function writeContract(
  address,
  functionName,
  args = [],
  { budgetMs, requireFinality = true, value = 0n } = {}
) {
  if (budgetMs === undefined) budgetMs = finalityBudgetMs();
  const client = getClient();
  console.log(
    `[Relayer] Writing ${functionName} to ${address} with args:`,
    args
  );

  const txHash = await client.writeContract({
    address,
    functionName,
    args,
    value: BigInt(value || 0),
  });
  console.log(`[Relayer] Broadcast tx: ${txHash}`);

  const finality = await pollTxFinality(txHash, { budgetMs });
  if (finality.status === "submitted") {
    return { txHash, finality };
  }
  if (finality.status !== "finalized") {
    if (requireFinality) {
      throw new Error(
        `Transaction ${txHash} did not finalize (status: ${finality.status})`
      );
    }
    console.warn(
      `[Relayer] ${txHash} still ${finality.status} after ${budgetMs}ms; returning unfinalized`
    );
    return { txHash, finality };
  }
  console.log(`[Relayer] Finalized: ${txHash}`);

  return { txHash, finality };
}

/**
 * Read from a GenLayer contract (no tx needed).
 */
export async function readContract(address, functionName, args = []) {
  const client = getClient();
  const raw = await client.readContract({
    address,
    functionName,
    args,
  });
  // Try to parse JSON if the result is a string
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Native balance of the relayer account, in wei. */
/**
 * How a GenLayer transaction ended, for a caller that needs to know whether to
 * try again.
 *
 * Consensus can fail. A transaction whose validators never reach a majority
 * settles as CANCELED with result_name NO_MAJORITY, and its state writes are
 * discarded. Nothing about that is visible in the contract state the caller is
 * polling, so without this check a review that failed consensus looks exactly
 * like one that is still running, and the client waits for a verdict that will
 * never arrive.
 */
export async function txOutcome(hash) {
  if (!hash) return { known: false };
  const tx = await rpc("eth_getTransactionByHash", [hash]).catch(() => null);
  if (!tx) return { known: false };

  const raw = tx.status;
  let status = null;
  if (typeof raw === "string") status = raw === "ACTIVATED" ? "PENDING" : raw;
  else if (typeof raw === "number") status = transactionsStatusNumberToName[String(raw)] || null;

  return {
    known: true,
    status,
    settled: ["FINALIZED", "ACCEPTED"].includes(status),
    // CANCELED is terminal and the writes are gone. Anything else is either
    // still in flight or landed.
    failed: status === "CANCELED",
    reason: tx.result_name || tx.consensus_data?.error || null,
  };
}

export async function getRelayerBalance() {
  const hex = await rpc("eth_getBalance", [deployer(), "latest"]);
  return BigInt(hex);
}

export const relayerAddress = () => deployer();

export { rpc, getClient, finalityBudgetMs };
