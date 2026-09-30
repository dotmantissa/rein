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

const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
const DEPLOYER =
  process.env.GENLAYER_DEPLOYER_ADDRESS ||
  "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53";
const PRIV_KEY = process.env.GENLAYER_PRIVATE_KEY;

const POLL_MS = Number(process.env.GENLAYER_POLL_MS || 3000);

// How long a single request may spend waiting for consensus. On a long-running
// host this can be generous; on a serverless host it must stay inside the
// platform's function ceiling or the caller gets a 504 with no tx hash to
// recover from. Bounded by wall clock, not poll count, so tuning POLL_MS can
// never change the worst-case request duration.
const FINALITY_BUDGET_MS = Number(process.env.GENLAYER_FINALITY_BUDGET_MS || 240000);

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

function getProvider() {
  if (!PRIV_KEY) throw new Error("GENLAYER_PRIVATE_KEY not configured");
  const wallet = new ethers.Wallet(PRIV_KEY);

  return {
    async request({ method, params = [] }) {
      if (method === "eth_sendTransaction") {
        const tx = params[0];
        const nonce = await rpc("eth_getTransactionCount", [
          DEPLOYER,
          "latest",
        ]);
        const chainId = await rpc("eth_chainId", []);
        const signed = await wallet.signTransaction({
          to: tx.to ?? null,
          data: tx.data,
          value: tx.value ?? "0x0",
          gas: tx.gas ?? "0x4C4B40",
          gasPrice: tx.gasPrice ?? "0x0",
          nonce,
          chainId: parseInt(chainId, 16),
        });
        return rpc("eth_sendRawTransaction", [signed]);
      }
      if (method === "eth_estimateGas") return "0x4C4B40";
      return rpc(method, params);
    },
  };
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient({
      chain: chains.studionet,
      endpoint: RPC_URL,
      account: DEPLOYER,
      provider: getProvider(),
    });
  }
  return _client;
}

export async function pollTxFinality(hash, { budgetMs = FINALITY_BUDGET_MS } = {}) {
  // A zero budget means the caller only wanted the transaction broadcast and
  // will confirm the outcome by reading contract state instead.
  if (budgetMs <= 0) return { status: "submitted", rawStatus: "SUBMITTED" };
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
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
 */
export async function writeContract(
  address,
  functionName,
  args = [],
  { budgetMs = FINALITY_BUDGET_MS, requireFinality = true } = {}
) {
  const client = getClient();
  console.log(
    `[Relayer] Writing ${functionName} to ${address} with args:`,
    args
  );

  const txHash = await client.writeContract({
    address,
    functionName,
    args,
    value: BigInt(0),
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

export { rpc, getClient, FINALITY_BUDGET_MS };
