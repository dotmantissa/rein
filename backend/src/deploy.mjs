import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import { readFileSync, writeFileSync } from "fs";
import { createClient, chains } from "genlayer-js";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
const DEPLOYER = process.env.GENLAYER_DEPLOYER_ADDRESS || "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53";
const PRIV_KEY = process.env.GENLAYER_PRIVATE_KEY;
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

const POLL_MS = 3000;
const MAX_POLLS = 80;

if (!PRIV_KEY) {
  console.error("GENLAYER_PRIVATE_KEY is not set in .env");
  process.exit(1);
}

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

async function pollStatus(hash) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const tx = await rpc("eth_getTransactionByHash", [hash]).catch(() => null);
    if (!tx) continue;
    const raw = tx.status;
    let name;
    if (typeof raw === "string")
      name = raw === "ACTIVATED" ? "PENDING" : raw;
    else if (typeof raw === "number")
      name = transactionsStatusNumberToName[String(raw)] ?? null;
    if (!name) continue;
    console.log(`  [Poll ${i + 1}] Status: ${name}`);
    if (["FINALIZED", "ACCEPTED"].includes(name)) return "finalized";
    if (["CANCELED"].includes(name)) return "failed";
  }
  return "timeout";
}

async function deployContract(contractPath, contractName, constructorArgs = []) {
  const wallet = new ethers.Wallet(PRIV_KEY);

  const provider = {
    async request({ method, params = [] }) {
      if (method === "eth_sendTransaction") {
        const tx = params[0];
        const nonce = await rpc("eth_getTransactionCount", [DEPLOYER, "latest"]);
        const chainId = await rpc("eth_chainId", []);
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

  const client = createClient({
    chain: chains.studionet,
    endpoint: RPC_URL,
    account: DEPLOYER,
    provider,
  });

  const contractCode = readFileSync(contractPath, "utf8");

  console.log(`\nDeploying ${contractName}...`);
  const deployHash = await client.deployContract({
    code: contractCode,
    args: constructorArgs,
  });
  console.log(`Transaction Hash: ${deployHash}`);

  const status = await pollStatus(deployHash);
  console.log(`Consensus result: ${status}`);

  if (status !== "finalized") {
    console.error(`Deploy of ${contractName} failed or timed out.`);
    return null;
  }

  // A deploy can reach FINALIZED consensus and still have failed: if the
  // constructor raises, every validator agrees it raised. Consensus status tells
  // us the network settled, not that the contract exists. Check the execution
  // result too, or a crashed constructor gets reported as a successful deploy.
  const tx = await rpc("eth_getTransactionByHash", [deployHash]).catch(() => null);
  const lr = tx?.consensus_data?.leader_receipt;
  const receiptData = Array.isArray(lr) ? lr[0] : lr;
  if (receiptData?.execution_result && receiptData.execution_result !== "SUCCESS") {
    let detail = receiptData.result ?? "";
    try {
      detail = Buffer.from(String(detail), "base64").toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim();
    } catch {}
    console.error(`  ${contractName} constructor failed: ${receiptData.execution_result} ${detail}`);
    return null;
  }

  const receipt = await rpc("eth_getTransactionReceipt", [deployHash]);
  const newAddress = receipt?.contractAddress || receipt?.to;
  console.log(`>>> ${contractName} Deployed At: ${newAddress} <<<`);

  // Prove the contract actually answers before we write its address anywhere.
  return newAddress;
}

function makeClient() {
  const wallet = new ethers.Wallet(PRIV_KEY);
  const provider = {
    async request({ method, params = [] }) {
      if (method === "eth_sendTransaction") {
        const tx = params[0];
        const nonce = await rpc("eth_getTransactionCount", [DEPLOYER, "latest"]);
        const chainId = await rpc("eth_chainId", []);
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
  return createClient({
    chain: chains.studionet,
    endpoint: RPC_URL,
    account: DEPLOYER,
    provider,
  });
}

async function main() {
  const client = makeClient();
  console.log("REIN Contract Deployment");
  console.log("========================\n");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Deployer: ${DEPLOYER}\n`);

  const addresses = {};

  // 1. Deploy MandateRegistry (no constructor args)
  addresses.mandateRegistry = await deployContract(
    new URL("../../contracts/mandate_registry.py", import.meta.url).pathname,
    "MandateRegistry",
    []
  );
  if (!addresses.mandateRegistry) process.exit(1);

  // 2. Deploy ReinCourt (needs registry address)
  addresses.reinCourt = await deployContract(
    new URL("../../contracts/rein_court.py", import.meta.url).pathname,
    "ReinCourt",
    [addresses.mandateRegistry]
  );
  if (!addresses.reinCourt) process.exit(1);

  // 3. Deploy Enforcer (needs court + registry addresses)
  addresses.enforcer = await deployContract(
    new URL("../../contracts/enforcer.py", import.meta.url).pathname,
    "Enforcer",
    [addresses.reinCourt, addresses.mandateRegistry]
  );
  if (!addresses.enforcer) process.exit(1);

  // Wire the registry to the two contracts allowed to act on it. Without this
  // the court cannot count reviewed actions and, more importantly, the enforcer
  // cannot revoke or restore: the registry would see an unknown caller. The
  // contracts are deployed in dependency order, so this has to happen after.
  console.log("\nWiring MandateRegistry to the court and enforcer...");
  for (const [fn, arg] of [
    ["set_court", addresses.reinCourt],
    ["set_enforcer", addresses.enforcer],
  ]) {
    const hash = await client.writeContract({
      address: addresses.mandateRegistry,
      functionName: fn,
      args: [arg],
      value: BigInt(0),
    });
    console.log(`  ${fn}(${arg}) -> ${hash}`);
    const status = await pollStatus(hash);
    if (status !== "finalized") {
      console.error(`  ${fn} did not finalize (${status}); the registry is not wired.`);
      process.exit(1);
    }
  }

  // Prove the wiring took, rather than trusting the transaction status.
  const wiring = await client.readContract({
    address: addresses.mandateRegistry,
    functionName: "get_wiring",
    args: [],
  });
  console.log(`  wiring reads back as: ${wiring}`);
  const parsed = JSON.parse(wiring);
  if (
    parsed.court?.toLowerCase() !== addresses.reinCourt.toLowerCase() ||
    parsed.enforcer?.toLowerCase() !== addresses.enforcer.toLowerCase()
  ) {
    console.error("  Wiring did not take. Revocations would be rejected by the registry.");
    process.exit(1);
  }

  console.log("\n\nAll contracts deployed successfully!");
  console.log("===================================");
  console.log(`MANDATE_REGISTRY_ADDRESS=${addresses.mandateRegistry}`);
  console.log(`REIN_COURT_ADDRESS=${addresses.reinCourt}`);
  console.log(`ENFORCER_ADDRESS=${addresses.enforcer}`);

  // Write addresses to a JSON file for the frontend/backend to use. Merge
  // rather than overwrite: this file also records the host-chain registry, and
  // rewriting it wholesale on a GenLayer redeploy silently dropped the address
  // and deploy block that revocation depends on.
  const addressFile = new URL("../../deployed_addresses.json", import.meta.url).pathname;
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(addressFile, "utf8"));
  } catch {}
  writeFileSync(
    addressFile,
    JSON.stringify({ ...existing, ...addresses }, null, 2) + "\n"
  );
  console.log(`\nAddresses written to ${addressFile}`);

  // Also rewrite .env, which is what the server and every script actually read.
  // Writing only the JSON file left the backend pointed at the previous
  // deployment, so a redeploy appeared to succeed while every call afterwards
  // still ran the old bytecode.
  const envFile = new URL("../.env", import.meta.url).pathname;
  const keys = {
    MANDATE_REGISTRY_ADDRESS: addresses.mandateRegistry,
    REIN_COURT_ADDRESS: addresses.reinCourt,
    ENFORCER_ADDRESS: addresses.enforcer,
  };
  let env = "";
  try {
    env = readFileSync(envFile, "utf8");
  } catch {
    console.warn(`\nNo .env at ${envFile}; skipping env update.`);
    return;
  }
  for (const [k, v] of Object.entries(keys)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    env = re.test(env) ? env.replace(re, line) : `${env.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(envFile, env);
  console.log(`Addresses written to ${envFile}`);
  console.log(
    "\nRemember to update the deployed backend's environment too, or it will " +
      "keep calling the previous contracts."
  );
}

main().catch((err) => {
  console.error("Deploy error:", err);
  process.exit(1);
});
