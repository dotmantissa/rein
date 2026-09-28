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

const POLL_MS = 3000;
const MAX_POLLS = 80;

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

export async function pollTxFinality(hash) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
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
 */
export async function writeContract(address, functionName, args = []) {
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

  const finality = await pollTxFinality(txHash);
  if (finality.status !== "finalized") {
    throw new Error(
      `Transaction ${txHash} did not finalize (status: ${finality.status})`
    );
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

export { rpc, getClient };
