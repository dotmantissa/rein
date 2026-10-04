/**
 * Compile the host-chain contract and write its ABI, bytecode and event topics
 * to backend/src/hostArtifacts.json.
 *
 * The Enforcer verifies revocations by matching a log topic in a Sepolia
 * receipt, so the topic hashes are emitted here rather than copied by hand into
 * two languages.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import solc from "solc";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../../contracts/host/ReinSessionKeyRegistry.sol");
const OUT = resolve(here, "hostArtifacts.json");
const NAME = "ReinSessionKeyRegistry";

const source = readFileSync(SOURCE, "utf8");

const input = {
  language: "Solidity",
  sources: { "ReinSessionKeyRegistry.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const fatal = (output.errors || []).filter((e) => e.severity === "error");
if (fatal.length) {
  for (const e of fatal) console.error(e.formattedMessage);
  process.exit(1);
}
for (const e of output.errors || []) {
  if (e.severity !== "error") console.warn(e.formattedMessage);
}

const artifact = output.contracts["ReinSessionKeyRegistry.sol"][NAME];
const abi = artifact.abi;
const iface = new ethers.Interface(abi);

// Topic0 for the two events the Enforcer authenticates against. Derived here so
// the Python side can be handed a value it did not have to compute itself, and
// so a rename of either event cannot silently break verification.
const topics = {};
for (const name of ["DelegationRevoked", "DelegationRestored", "DelegationOpened"]) {
  topics[name] = ethers.id(iface.getEvent(name).format("sighash"));
}

// Selectors the Enforcer uses for eth_call state checks.
const selectors = {
  isActive: iface.getFunction("isActive").selector,
  stateOf: iface.getFunction("stateOf").selector,
};

writeFileSync(
  OUT,
  JSON.stringify(
    {
      name: NAME,
      compiler: solc.version(),
      abi,
      bytecode: "0x" + artifact.evm.bytecode.object,
      eventTopics: topics,
      selectors,
    },
    null,
    2
  ) + "\n"
);

console.log(`Compiled ${NAME} with ${solc.version()}`);
console.log(`  bytecode: ${artifact.evm.bytecode.object.length / 2} bytes`);
for (const [k, v] of Object.entries(topics)) console.log(`  topic ${k}: ${v}`);
for (const [k, v] of Object.entries(selectors)) console.log(`  selector ${k}: ${v}`);
console.log(`Written to ${OUT}`);
