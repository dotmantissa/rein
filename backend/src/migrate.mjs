import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set in .env");
  process.exit(1);
}

async function migrate() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log("Connected to Neon PostgreSQL");

  // Mandates table: stores delegation mandate records synced from GenLayer
  await client.query(`
    CREATE TABLE IF NOT EXISTS mandates (
      id SERIAL PRIMARY KEY,
      delegation_id TEXT UNIQUE NOT NULL,
      delegator TEXT NOT NULL,
      agent_address TEXT NOT NULL,
      mandate_text TEXT NOT NULL,
      mandate_hash TEXT NOT NULL,
      spend_ceiling_wei TEXT NOT NULL DEFAULT '0',
      chain_id TEXT NOT NULL DEFAULT '1',
      session_key_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      host_registry TEXT,
      host_delegation_id TEXT,
      host_open_tx_hash TEXT,
      host_status TEXT NOT NULL DEFAULT 'PENDING',
      genlayer_tx_hash TEXT,
      genlayer_contract_address TEXT,
      user_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Created mandates table");

  // Actions table: agent actions submitted for review
  await client.query(`
    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY,
      action_id TEXT UNIQUE NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES mandates(delegation_id),
      tx_hash TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      action_description TEXT NOT NULL DEFAULT '',
      submitted_by TEXT,
      genlayer_tx_hash TEXT,
      review_attempts INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Created actions table");

  // Verdicts table: court judgements
  await client.query(`
    CREATE TABLE IF NOT EXISTS verdicts (
      id SERIAL PRIMARY KEY,
      verdict_id TEXT UNIQUE NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES mandates(delegation_id),
      action_id TEXT REFERENCES actions(action_id),
      tx_hash TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'ambiguous',
      severity TEXT NOT NULL DEFAULT 'LOW',
      breached_clause TEXT,
      reasoning TEXT,
      confidence REAL DEFAULT 0,
      attributed BOOLEAN NOT NULL DEFAULT FALSE,
      facts TEXT,
      genlayer_tx_hash TEXT,
      genlayer_contract_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Created verdicts table");

  // Revocations table: enforced revocations
  await client.query(`
    CREATE TABLE IF NOT EXISTS revocations (
      id SERIAL PRIMARY KEY,
      revocation_id TEXT UNIQUE NOT NULL,
      delegation_id TEXT NOT NULL REFERENCES mandates(delegation_id),
      verdict_id TEXT REFERENCES verdicts(verdict_id),
      severity TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING_HOST_REVOCATION',
      host_state TEXT NOT NULL DEFAULT 'PENDING_HOST',
      evm_tx_hash TEXT,
      evm_block_number TEXT,
      confirm_tx_hash TEXT,
      watcher TEXT,
      genlayer_tx_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Created revocations table");

  // Appeals table: operator appeals against revocations
  await client.query(`
    CREATE TABLE IF NOT EXISTS appeals (
      id SERIAL PRIMARY KEY,
      appeal_id TEXT UNIQUE NOT NULL,
      revocation_id TEXT NOT NULL REFERENCES revocations(revocation_id),
      appeal_reason TEXT NOT NULL,
      bond_amount TEXT NOT NULL DEFAULT '0',
      bond_wei TEXT NOT NULL DEFAULT '0',
      bond_settlement TEXT,
      bond_paid_to TEXT,
      appellant TEXT,
      watcher TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      restoration_state TEXT NOT NULL DEFAULT 'NONE',
      restoration_tx_hash TEXT,
      restoration_confirm_tx_hash TEXT,
      adjudication_result TEXT,
      genlayer_tx_hash TEXT,
      filed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
  `);
  console.log("Created appeals table");

  // Users table: Privy authenticated users
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      privy_did TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      wallet_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Created users table");

  // The tables above already exist on any deployment that has run before, so
  // CREATE TABLE IF NOT EXISTS silently skips the new columns. Add them here so
  // a migration is safe to re-run against either an empty or a live database.
  const additions = [
    ["mandates", "host_registry", "TEXT"],
    ["mandates", "host_delegation_id", "TEXT"],
    ["mandates", "host_open_tx_hash", "TEXT"],
    ["mandates", "host_status", "TEXT NOT NULL DEFAULT 'PENDING'"],
    ["actions", "review_attempts", "INTEGER NOT NULL DEFAULT 1"],
    ["verdicts", "attributed", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["verdicts", "facts", "TEXT"],
    ["revocations", "host_state", "TEXT NOT NULL DEFAULT 'PENDING_HOST'"],
    ["revocations", "evm_block_number", "TEXT"],
    ["revocations", "confirm_tx_hash", "TEXT"],
    ["revocations", "watcher", "TEXT"],
    ["appeals", "bond_wei", "TEXT NOT NULL DEFAULT '0'"],
    ["appeals", "bond_settlement", "TEXT"],
    ["appeals", "bond_paid_to", "TEXT"],
    ["appeals", "appellant", "TEXT"],
    ["appeals", "watcher", "TEXT"],
    ["appeals", "restoration_state", "TEXT NOT NULL DEFAULT 'NONE'"],
    ["appeals", "restoration_tx_hash", "TEXT"],
    ["appeals", "restoration_confirm_tx_hash", "TEXT"],
  ];
  for (const [table, column, type] of additions) {
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`
    );
  }
  console.log(`Added ${additions.length} columns where missing`);

  // Indexes for performance
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mandates_delegator ON mandates(delegator);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mandates_status ON mandates(status);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_actions_delegation ON actions(delegation_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_verdicts_delegation ON verdicts(delegation_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_revocations_delegation ON revocations(delegation_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_appeals_revocation ON appeals(revocation_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_revocations_verdict ON revocations(verdict_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_revocations_host_state ON revocations(host_state);`);
  console.log("Created indexes");

  await client.end();
  console.log("Migration complete");
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
