/**
 * Deploy ReinSessionKeyRegistry to the host EVM chain and record its address.
 *
 * The guardian is the relayer account that submits revocations, which is the
 * same account the Enforcer's audit trail points at. Pass GUARDIAN_ADDRESS to
 * separate the two.
 */

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = JSON.parse(readFileSync(resolve(here, "hostArtifacts.json"), "utf8"));

const RPC = process.env.HOST_CHAIN_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = process.env.HOST_CHAIN_ID || "11155111";
const KEY = process.env.HOST_CHAIN_PRIVATE_KEY || process.env.GENLAYER_PRIVATE_KEY;

if (!KEY) {
  console.error("HOST_CHAIN_PRIVATE_KEY (or GENLAYER_PRIVATE_KEY) is not set");
  process.exit(1);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, Number(CHAIN_ID));
  const wallet = new ethers.Wallet(KEY, provider);
  const guardian = process.env.GUARDIAN_ADDRESS || wallet.address;

  const balance = await provider.getBalance(wallet.address);
  console.log(`Host chain: ${RPC} (chain ${CHAIN_ID})`);
  console.log(`Deployer:   ${wallet.address}`);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log(`Guardian:   ${guardian}\n`);

  if (balance === 0n) {
    console.error("Deployer has no balance on the host chain.");
    process.exit(1);
  }

  const factory = new ethers.ContractFactory(artifacts.abi, artifacts.bytecode, wallet);
  const contract = await factory.deploy(guardian);
  console.log(`Deploy tx: ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`\n>>> ReinSessionKeyRegistry deployed at: ${address} <<<`);

  // Prove it answers before anything is written down.
  const onChainGuardian = await contract.guardian();
  console.log(`Guardian reads back as: ${onChainGuardian}`);

  const deployReceipt = await provider.getTransactionReceipt(
    contract.deploymentTransaction().hash
  );
  const deployBlock = Number(deployReceipt.blockNumber);
  console.log(`Deployed in block: ${deployBlock}`);

  const addressFile = resolve(here, "../../deployed_addresses.json");
  let addresses = {};
  try {
    addresses = JSON.parse(readFileSync(addressFile, "utf8"));
  } catch {}
  addresses.hostChain = {
    chainId: CHAIN_ID,
    rpcUrl: RPC,
    sessionKeyRegistry: address,
    guardian: onChainGuardian,
    // Recorded so a log scan has a floor. Without it, recovering a lost
    // revocation hash means walking the chain back to genesis in 50k windows.
    deployBlock,
  };
  writeFileSync(addressFile, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`\nAddresses written to ${addressFile}`);

  const envFile = resolve(here, "../.env");
  const keys = {
    HOST_CHAIN_RPC_URL: RPC,
    HOST_CHAIN_ID: CHAIN_ID,
    HOST_SESSION_KEY_REGISTRY: address,
    HOST_REGISTRY_DEPLOY_BLOCK: String(deployBlock),
  };
  let env = "";
  try {
    env = readFileSync(envFile, "utf8");
  } catch {
    console.warn(`No .env at ${envFile}; skipping env update.`);
    return;
  }
  for (const [k, v] of Object.entries(keys)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    env = re.test(env) ? env.replace(re, line) : `${env.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(envFile, env);
  console.log(`Host chain config written to ${envFile}`);
}

main().catch((err) => {
  console.error("Host deploy error:", err);
  process.exit(1);
});
