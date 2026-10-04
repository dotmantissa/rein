/**
 * End-to-end proof that a REIN revocation stops the agent's key.
 *
 * Runs against the real ReinSessionKeyRegistry on the host chain:
 *
 *   1. open a delegation with an escrowed allowance and a session key
 *   2. spend from it with that key                      -> succeeds
 *   3. revoke it as the guardian                        -> succeeds
 *   4. spend again with the same, still valid, key       -> reverts
 *   5. restore it after an overturned appeal             -> succeeds
 *   6. spend again                                       -> succeeds
 *
 * Step 4 is the whole claim. Everything else is the setup that makes it mean
 * something. Prints every transaction hash so the run can be audited on a
 * block explorer.
 */

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = JSON.parse(readFileSync(resolve(here, "hostArtifacts.json"), "utf8"));

const RPC = process.env.HOST_CHAIN_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = Number(process.env.HOST_CHAIN_ID || 11155111);
const ADDRESS = process.env.HOST_SESSION_KEY_REGISTRY;
const KEY = process.env.HOST_CHAIN_PRIVATE_KEY || process.env.GENLAYER_PRIVATE_KEY;

if (!ADDRESS || !KEY) {
  console.error("HOST_SESSION_KEY_REGISTRY and HOST_CHAIN_PRIVATE_KEY must be set");
  process.exit(1);
}

const DELEGATION_ID = process.argv[2] || `del_verify_${Date.now()}`;
const CEILING = ethers.parseEther("0.0008");
const ESCROW = ethers.parseEther("0.0008");
const SPEND = ethers.parseEther("0.0002");
const SESSION_GAS = ethers.parseEther("0.0025");

const explorer = (h) =>
  CHAIN_ID === 11155111 ? `https://sepolia.etherscan.io/tx/${h}` : h;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const guardian = new ethers.Wallet(KEY, provider);

  // A deterministic session key, so a re-run of this script uses the same one.
  const sessionKey = new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes("rein-host-verification-session-key-v1")),
    provider
  );
  const agent = sessionKey.address;
  const sink = "0x000000000000000000000000000000000000dEaD";

  const asGuardian = new ethers.Contract(ADDRESS, artifacts.abi, guardian);
  const asSessionKey = new ethers.Contract(ADDRESS, artifacts.abi, sessionKey);

  const handle = ethers.keccak256(ethers.toUtf8Bytes(DELEGATION_ID));

  console.log(`Registry:      ${ADDRESS}`);
  console.log(`Chain:         ${CHAIN_ID}`);
  console.log(`Guardian:      ${guardian.address}`);
  console.log(`Session key:   ${sessionKey.address}`);
  console.log(`Delegation:    ${DELEGATION_ID}`);
  console.log(`Handle:        ${handle}\n`);

  // ethers v6 passes eth_estimateGas through unpadded, and an estimate a few
  // hundred gas short lands as an out-of-gas failure rather than a revert.
  const withBuffer = async (method, args, overrides = {}) => {
    const estimate = await method.estimateGas(...args, overrides);
    return method(...args, { ...overrides, gasLimit: (estimate * 140n) / 100n });
  };

  const step = async (label, fn) => {
    const tx = await fn();
    const receipt = await tx.wait(1);
    console.log(`  ${label}: ${explorer(tx.hash)} (block ${receipt.blockNumber})`);
    return receipt;
  };

  const expectRevert = async (label, fn) => {
    try {
      const tx = await fn();
      await tx.wait(1);
      throw new Error(`${label} was expected to revert but succeeded`);
    } catch (err) {
      const reason =
        err.revert?.name ||
        (err.info?.error?.message ?? err.shortMessage ?? err.message);
      if (String(reason).includes("was expected to revert")) throw err;
      console.log(`  ${label}: reverted as required (${reason})`);
      return reason;
    }
  };

  // Gas for the session key, so the spend attempts are genuine.
  const skBalance = await provider.getBalance(sessionKey.address);
  if (skBalance < SESSION_GAS / 2n) {
    console.log("0. Funding the session key for gas");
    await step("fund", () =>
      guardian.sendTransaction({ to: sessionKey.address, value: SESSION_GAS })
    );
  }

  console.log("\n1. Open the delegation with an escrowed allowance");
  await step("openDelegation", () =>
    withBuffer(
      asGuardian.openDelegation,
      [handle, agent, sessionKey.address, CEILING],
      { value: ESCROW }
    )
  );
  console.log(`  isActive: ${await asGuardian.isActive(handle)}`);

  console.log("\n2. The agent spends while the delegation is live");
  await step("spend", () =>
    withBuffer(asSessionKey.spend, [handle, sink, SPEND, "0x"])
  );
  let d = await asGuardian.getDelegation(handle);
  console.log(`  spent: ${ethers.formatEther(d.spentWei)} ETH of ${ethers.formatEther(d.ceilingWei)} ETH`);

  console.log("\n3. The guardian revokes on a breach verdict");
  const fakeVerdictRef = ethers.keccak256(ethers.toUtf8Bytes(`vrd_${DELEGATION_ID}_0`));
  const revokeReceipt = await step("revoke", () =>
    withBuffer(asGuardian.revoke, [handle, fakeVerdictRef])
  );
  console.log(`  isActive: ${await asGuardian.isActive(handle)}`);
  const revokedLog = revokeReceipt.logs.find(
    (l) => l.topics[0] === artifacts.eventTopics.DelegationRevoked
  );
  console.log(`  DelegationRevoked topic0: ${revokedLog?.topics?.[0]}`);
  console.log(`  DelegationRevoked handle: ${revokedLog?.topics?.[1]}`);
  if (!revokedLog) throw new Error("revoke did not emit DelegationRevoked");
  if (revokedLog.topics[1] !== handle) throw new Error("event handle mismatch");

  console.log("\n4. The same session key tries to spend again");
  await expectRevert("spend", () => asSessionKey.spend(handle, sink, SPEND, "0x"));

  console.log("\n5. An overturned appeal restores the delegation");
  const appealRef = ethers.keccak256(ethers.toUtf8Bytes(`apl_${DELEGATION_ID}_0`));
  const restoreReceipt = await step("restore", () =>
    withBuffer(asGuardian.restore, [handle, appealRef])
  );
  console.log(`  isActive: ${await asGuardian.isActive(handle)}`);
  const restoredLog = restoreReceipt.logs.find(
    (l) => l.topics[0] === artifacts.eventTopics.DelegationRestored
  );
  if (!restoredLog) throw new Error("restore did not emit DelegationRestored");

  console.log("\n6. The agent can spend again");
  await step("spend", () =>
    withBuffer(asSessionKey.spend, [handle, sink, SPEND, "0x"])
  );
  d = await asGuardian.getDelegation(handle);
  console.log(`  spent: ${ethers.formatEther(d.spentWei)} ETH, state ${["NONE","ACTIVE","REVOKED"][Number(d.state)]}`);

  console.log("\n7. Only the guardian may revoke");
  await expectRevert("revoke by the session key", () =>
    asSessionKey.revoke(handle, fakeVerdictRef)
  );

  console.log("\nHost-chain enforcement verified end to end.");
}

main().catch((err) => {
  console.error("\nVerification FAILED:", err.message ?? err);
  process.exit(1);
});
