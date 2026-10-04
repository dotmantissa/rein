/**
 * Deploy a throwaway contract and call one method, reporting what consensus did.
 *
 * This exists because StudioNet tells you very little when a nondeterministic
 * transaction fails. A contract that crashes the GenVM settles as CANCELED with
 * `result_name: NO_MAJORITY` and no receipts at all, which is indistinguishable
 * from validators disagreeing. Isolating one primitive in a minimal contract and
 * reading the votes and the leader receipt back is how you tell them apart.
 *
 * Usage: node src/probe.mjs <contract.py> <Name> [ctorArg] [probeArg]
 *
 * The contract needs a `probe(str)` write method and a `get_last()` view, so the
 * script can distinguish "consensus succeeded" from "the write actually landed".
 */

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { createClient, chains } from "genlayer-js";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { ethers } from "ethers";
import { rpc } from "./genlayerRelayer.js";

const RPC_URL = process.env.GENLAYER_RPC_URL;
const DEPLOYER = process.env.GENLAYER_DEPLOYER_ADDRESS;
const GAS_LIMIT = process.env.GENLAYER_GAS_LIMIT || "0x5F5E100";
const wallet = new ethers.Wallet(process.env.GENLAYER_PRIVATE_KEY);
const provider = {
  async request({ method, params = [] }) {
    if (method === "eth_sendTransaction") {
      const tx = params[0];
      const nonce = await rpc("eth_getTransactionCount", [DEPLOYER, "latest"]);
      const chainId = await rpc("eth_chainId", []);
      const signed = await wallet.signTransaction({
        to: tx.to ?? null, data: tx.data, value: tx.value ?? "0x0",
        gas: tx.gas ?? GAS_LIMIT, gasPrice: tx.gasPrice ?? "0x0",
        nonce, chainId: parseInt(chainId, 16),
      });
      return rpc("eth_sendRawTransaction", [signed]);
    }
    if (method === "eth_estimateGas") return GAS_LIMIT;
    return rpc(method, params);
  },
};
const client = createClient({ chain: chains.studionet, endpoint: RPC_URL, account: DEPLOYER, provider });

const name = (raw) =>
  typeof raw === "string" ? (raw === "ACTIVATED" ? "PENDING" : raw)
  : transactionsStatusNumberToName[String(raw)] ?? null;

async function poll(hash, maxS = 420) {
  const deadline = Date.now() + maxS * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20000));
    const tx = await rpc("eth_getTransactionByHash", [hash]).catch(() => null);
    const s = name(tx?.status);
    if (s !== last) { console.log(`   status: ${s}`); last = s; }
    if (["FINALIZED", "ACCEPTED", "CANCELED", "UNDETERMINED"].includes(s)) return { s, tx };
  }
  return { s: last ?? "TIMEOUT", tx: await rpc("eth_getTransactionByHash", [hash]).catch(() => null) };
}

function receiptError(tx) {
  const lr = tx?.consensus_data?.leader_receipt;
  const r = Array.isArray(lr) ? lr[0] : lr;
  if (!r) return "(no leader receipt)";
  let d = r.result ?? "";
  try { d = Buffer.from(String(d), "base64").toString("utf8"); } catch {}
  return `${r.execution_result}: ${String(d).replace(/[^\x20-\x7e]/g, " ").slice(0, 400)}`;
}

const [file, contractName, ctorArg, probeArg] = process.argv.slice(2);

console.log(`Deploying ${contractName}...`);
const dep = await client.deployContract({
  code: readFileSync(file, "utf8"),
  args: ctorArg ? [ctorArg] : [],
});
console.log(`   deploy tx: ${dep}`);
const { s: ds, tx: dtx } = await poll(dep);
console.log(`   deploy: ${ds} / ${receiptError(dtx)}`);
if (!["FINALIZED", "ACCEPTED"].includes(ds)) process.exit(1);
const receipt = await rpc("eth_getTransactionReceipt", [dep]);
const addr = receipt?.contractAddress || receipt?.to;
console.log(`   at: ${addr}`);

console.log(`Calling probe(${probeArg})...`);
const hash = await client.writeContract({ address: addr, functionName: "probe", args: [probeArg], value: 0n });
console.log(`   probe tx: ${hash}`);
const { s, tx } = await poll(hash);
console.log(`   probe: ${s}`);
console.log(`   receipt: ${receiptError(tx)}`);
const last = await client.readContract({ address: addr, functionName: "get_last", args: [] }).catch((e) => `read failed: ${e.message}`);
console.log(`   get_last: ${last}`);
