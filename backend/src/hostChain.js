/**
 * Host-chain relayer.
 *
 * REIN's promise is that a semantic verdict on GenLayer takes spending
 * authority away from an agent on the chain where the money is. This module is
 * the part that actually does it: it opens delegations on
 * ReinSessionKeyRegistry, and it submits the revoke and restore transactions
 * the Enforcer then reads back over JSON-RPC before it will record a
 * delegation as revoked or restored.
 *
 * Nothing here is trusted by the contracts. The Enforcer re-derives the event
 * topic, the delegation handle and the expected state itself, so a relayer that
 * reported a hash it had not sent, or sent a transaction to the wrong contract,
 * would simply fail confirmation.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));

let _artifacts = null;
function artifacts() {
  if (!_artifacts) {
    _artifacts = JSON.parse(readFileSync(resolve(here, "hostArtifacts.json"), "utf8"));
  }
  return _artifacts;
}

/**
 * Configuration, read at call time rather than captured at import.
 *
 * ESM evaluates every imported module before the importing module's own body,
 * so a module that reads process.env at its top level sees the environment
 * before dotenv.config() has run. That is why this used to report the host
 * chain as unconfigured in any script that loads its own .env: the values were
 * captured too early. Reading them lazily costs nothing and removes the
 * ordering trap entirely.
 */
function cfg() {
  return {
    chainId: process.env.HOST_CHAIN_ID || "11155111",
    rpcUrl:
      process.env.HOST_CHAIN_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
    registryAddress: process.env.HOST_SESSION_KEY_REGISTRY || "",
    // Nothing concerning this registry happened before it existed, so a log
    // scan need never look further back than here.
    deployBlock: Number(process.env.HOST_REGISTRY_DEPLOY_BLOCK || 0),
    key: process.env.HOST_CHAIN_PRIVATE_KEY || process.env.GENLAYER_PRIVATE_KEY || "",
  };
}

export const hostChainId = () => cfg().chainId;
export const hostRpcUrl = () => cfg().rpcUrl;
export const hostRegistryAddress = () => cfg().registryAddress;

// How long to wait for a host-chain transaction to be mined before handing the
// hash back unconfirmed. The Enforcer confirms from the receipt anyway, so a
// slow block only delays the next poll rather than losing the revocation.
const mineTimeoutMs = () => Number(process.env.HOST_MINE_TIMEOUT_MS || 90000);

// ethers v6 uses eth_estimateGas verbatim, with no headroom. A revoke that was
// estimated a few hundred gas short runs out of gas and lands as a failed
// transaction, and a failed transaction is not a revocation -- the Enforcer
// checks the receipt status and would rightly refuse to confirm it. Padding the
// estimate is cheap: unused gas is refunded.
const gasBufferPercent = () => Number(process.env.HOST_GAS_BUFFER_PERCENT || 40);

async function withGasBuffer(contractMethod, args, overrides = {}) {
  const opts = { ...overrides };
  try {
    const estimate = await contractMethod.estimateGas(...args, overrides);
    opts.gasLimit = (estimate * BigInt(100 + gasBufferPercent())) / 100n;
  } catch (err) {
    // A failed estimate usually means the call itself would revert. Let the
    // send surface that rather than guessing a limit and burning gas on it.
    throw err;
  }
  return contractMethod(...args, opts);
}

export function hostChainConfigured() {
  const c = cfg();
  return Boolean(c.key && c.registryAddress);
}

let _provider = null;
let _providerFor = null;
function provider() {
  const { rpcUrl, chainId } = cfg();
  const fingerprint = `${rpcUrl}|${chainId}`;
  if (!_provider || _providerFor !== fingerprint) {
    _provider = new ethers.JsonRpcProvider(rpcUrl, Number(chainId), {
      staticNetwork: true,
    });
    _providerFor = fingerprint;
  }
  return _provider;
}

function guardian() {
  if (!hostChainConfigured()) {
    throw new Error(
      "Host chain is not configured: set HOST_CHAIN_PRIVATE_KEY and HOST_SESSION_KEY_REGISTRY"
    );
  }
  return new ethers.Wallet(cfg().key, provider());
}

function registry(signerOrProvider) {
  const { registryAddress } = cfg();
  if (!registryAddress) {
    throw new Error("HOST_SESSION_KEY_REGISTRY is not set");
  }
  return new ethers.Contract(registryAddress, artifacts().abi, signerOrProvider);
}

/**
 * The host-chain handle for a GenLayer delegation_id.
 *
 * The Solidity registry keys delegations by keccak256(bytes(delegation_id)) and
 * MandateRegistry derives the same value, so all three sides agree on which
 * delegation is meant without any of them being told.
 */
export function delegationHandle(delegationId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(delegationId)));
}

export function verdictRef(verdictId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(verdictId)));
}

export function guardianAddress() {
  const { key } = cfg();
  return key ? new ethers.Wallet(key).address : null;
}

async function send(label, call) {
  const tx = await call();
  console.log(`[HostChain] ${label} tx: ${tx.hash}`);
  const timeout = mineTimeoutMs();
  let receipt = null;
  try {
    receipt = await tx.wait(1, timeout);
  } catch (err) {
    console.warn(
      `[HostChain] ${label} ${tx.hash} not mined within ${timeout}ms: ${err.message}`
    );
  }
  return {
    hash: tx.hash,
    mined: Boolean(receipt),
    status: receipt ? Number(receipt.status) : null,
    blockNumber: receipt ? Number(receipt.blockNumber) : null,
  };
}

/**
 * Open a delegation on the host chain and escrow its allowance.
 *
 * The relayer does this as the operator's custodian, which is what the
 * email-only sign-in implies: the account that opens a delegation is the
 * account that can withdraw its unspent escrow. A self-custodial operator can
 * call openDelegation themselves with the same handle and skip this.
 */
export async function openDelegation({
  delegationId,
  agentAddress,
  sessionKey,
  ceilingWei,
  escrowWei = "0",
}) {
  const handle = delegationHandle(delegationId);
  const contract = registry(guardian());

  // Opening is idempotent from the caller's point of view. A broadcast whose
  // hash we lost, or a retried request, must not leave a registered mandate
  // permanently unenforceable just because the host chain already knows about
  // it. Only an existing delegation that names the same agent and key counts as
  // already open; anything else is a genuine conflict and is raised.
  const existing = await contract
    .getDelegation(handle)
    .then((d) => d)
    .catch(() => null);
  if (existing) {
    const sameAgent =
      existing.agent.toLowerCase() === ethers.getAddress(agentAddress).toLowerCase();
    const sameKey =
      existing.sessionKey.toLowerCase() === ethers.getAddress(sessionKey).toLowerCase();
    if (sameAgent && sameKey) {
      console.log(`[HostChain] openDelegation(${delegationId}) already open; reusing`);
      return { hash: null, mined: true, status: 1, blockNumber: null, handle, alreadyOpen: true };
    }
    throw new Error(
      `Host chain already has a delegation at ${handle} for a different agent ` +
        `(${existing.agent} / ${existing.sessionKey}); refusing to reuse it`
    );
  }

  const result = await send(`openDelegation(${delegationId})`, () =>
    withGasBuffer(
      contract.openDelegation,
      [
        handle,
        ethers.getAddress(agentAddress),
        ethers.getAddress(sessionKey),
        BigInt(ceilingWei || "0"),
      ],
      { value: BigInt(escrowWei || "0") }
    )
  );
  return { ...result, handle };
}

/** Submit the revocation the Enforcer will then read back. */
export async function revokeDelegation({ delegationId, verdictId }) {
  const handle = delegationHandle(delegationId);
  const contract = registry(guardian());
  const result = await send(`revoke(${delegationId})`, () =>
    withGasBuffer(contract.revoke, [handle, verdictRef(verdictId)])
  );
  return { ...result, handle };
}

/** Submit the restoration an overturned appeal earned. */
export async function restoreDelegation({ delegationId, appealId }) {
  const handle = delegationHandle(delegationId);
  const contract = registry(guardian());
  const result = await send(`restore(${delegationId})`, () =>
    withGasBuffer(contract.restore, [handle, verdictRef(appealId)])
  );
  return { ...result, handle };
}

/** Whether the agent's session key can still spend. */
export async function isActive(delegationId) {
  const contract = registry(provider());
  return contract.isActive(delegationHandle(delegationId));
}

export async function getDelegation(delegationId) {
  const contract = registry(provider());
  const d = await contract.getDelegation(delegationHandle(delegationId));
  return {
    delegator: d.delegator,
    agent: d.agent,
    sessionKey: d.sessionKey,
    ceilingWei: d.ceilingWei.toString(),
    spentWei: d.spentWei.toString(),
    escrowWei: d.escrowWei.toString(),
    state: ["NONE", "ACTIVE", "REVOKED"][Number(d.state)] || "UNKNOWN",
    verdictRef: d.verdictRef,
    appealRef: d.appealRef,
  };
}

/**
 * Find the transaction that revoked or restored a delegation, by its event.
 *
 * The Enforcer confirms against a transaction hash, so losing that hash leaves
 * a revocation that happened but can never be recorded. That is not a remote
 * possibility: the relayer sends the transaction and then writes the hash, and a
 * crash between the two is enough. A second attempt is no help either, because
 * `revoke` on an already revoked delegation reverts.
 *
 * The event is the recovery. It is indexed by the delegation handle, so the
 * transaction can be found again from nothing but the delegation id.
 */
export async function findStateChangeTx(delegationId, event = "DelegationRevoked") {
  const { registryAddress } = cfg();
  if (!registryAddress) return null;
  const topic0 = artifacts().eventTopics[event];
  if (!topic0) throw new Error(`unknown host-chain event ${event}`);

  const p = provider();
  const handle = delegationHandle(delegationId);
  const topics = [topic0, handle];

  // Public RPCs cap eth_getLogs at a block range -- 50,000 on the endpoints
  // used here -- and answer a wider request with an error rather than a
  // truncated result, so a single fromBlock:0 query silently finds nothing.
  // Scan in windows, newest first, because recovery is almost always looking
  // for something that happened minutes ago.
  const WINDOW = Number(process.env.HOST_LOG_WINDOW || 45000);
  const floor = Math.max(0, cfg().deployBlock);
  let to = await p.getBlockNumber().catch(() => null);
  if (to === null) return null;

  while (to >= floor) {
    const from = Math.max(floor, to - WINDOW + 1);
    const logs = await p
      .getLogs({ address: registryAddress, topics, fromBlock: from, toBlock: to })
      .catch((err) => {
        console.warn(
          `[HostChain] log lookup for ${event} in ${from}-${to} failed: ${err.message}`
        );
        return null;
      });
    if (logs === null) return null;
    if (logs.length) {
      // The most recent one: a delegation can be revoked, restored and revoked
      // again, and it is the latest that the current state corresponds to.
      const latest = logs[logs.length - 1];
      return {
        hash: latest.transactionHash,
        blockNumber: Number(latest.blockNumber),
      };
    }
    if (from === floor) break;
    to = from - 1;
  }
  return null;
}

/** Whether a submitted host-chain transaction has been mined. */
export async function txMined(hash) {
  if (!hash) return { mined: false };
  const receipt = await provider()
    .getTransactionReceipt(hash)
    .catch(() => null);
  if (!receipt) return { mined: false };
  return {
    mined: true,
    success: Number(receipt.status) === 1,
    blockNumber: Number(receipt.blockNumber),
  };
}

export function hostChainInfo() {
  const c = cfg();
  return {
    chainId: c.chainId,
    rpcUrl: c.rpcUrl,
    sessionKeyRegistry: c.registryAddress || null,
    deployBlock: c.deployBlock || null,
    guardian: guardianAddress(),
    configured: hostChainConfigured(),
  };
}
