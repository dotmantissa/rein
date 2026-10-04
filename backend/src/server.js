/**
 * REIN Backend Server
 *
 * Express API that bridges the Next.js frontend to GenLayer contracts
 * and the Neon PostgreSQL database. Handles Privy authentication,
 * transaction abstraction, and the complete mandate lifecycle.
 */

import dns from "dns";
import { Agent, setGlobalDispatcher } from "undici";
import dotenv from "dotenv";

// Serverless runtimes often resolve AAAA records that have no route out, which
// makes Neon and the GenLayer RPC hang instead of failing fast. Pin to IPv4.
dns.setDefaultResultOrder("ipv4first");
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

dotenv.config();

import express from "express";
import cors from "cors";
import pg from "pg";
import { PrivyClient } from "@privy-io/server-auth";
import {
  writeContract,
  readContract,
  pollTxFinality,
  getRelayerBalance,
  relayerAddress,
  txOutcome,
} from "./genlayerRelayer.js";
import {
  delegationHandle,
  findStateChangeTx,
  hostChainConfigured,
  hostChainInfo,
  isActive as hostIsActive,
  openDelegation as hostOpenDelegation,
  restoreDelegation as hostRestoreDelegation,
  revokeDelegation as hostRevokeDelegation,
  txMined as hostTxMined,
  hostChainId,
  hostRegistryAddress,
} from "./hostChain.js";

const { Pool } = pg;

const app = express();
app.use(express.json());
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Non-browser callers (curl, health checks) send no Origin header.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      // Any preview deployment of the frontend project.
      if (/^https:\/\/reinprotocol-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Privy client for auth verification
const privy = new PrivyClient(
  process.env.PRIVY_APP_ID,
  process.env.PRIVY_APP_SECRET
);

// Contract addresses from deployment
// Budget for writes that only need broadcasting. Zero means return as soon as
// there is a transaction hash; the outcome is confirmed later by reading
// contract state, which keeps every request inside a serverless function
// ceiling even though consensus on an LLM call takes 50-90 seconds.
const SUBMIT_BUDGET_MS = Number(process.env.GENLAYER_SUBMIT_BUDGET_MS || 0);
// Ceiling for waiting on a deterministic write to appear in contract state.
const READBACK_BUDGET_MS = Number(process.env.GENLAYER_READBACK_BUDGET_MS || 40000);

// Waits for a deterministic write to become visible in contract state. The
// transaction status cannot be used for this: GenLayer has been observed
// reporting CANCELED for transactions whose writes did land, so the only
// dependable signal is reading the value back. Bounded so a stuck write
// surfaces as a slow response rather than a serverless timeout.
async function waitForState(read, predicate, budgetMs = READBACK_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    last = await read().catch(() => null);
    const hit = predicate(last);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    // Ten seconds, not three: StudioNet allows 500 RPC requests an hour and a
    // tighter loop spends the whole budget on a single waiting request.
    await new Promise((r) => setTimeout(r, 10000));
  }
}

const CONTRACTS = {
  mandateRegistry: process.env.MANDATE_REGISTRY_ADDRESS,
  reinCourt: process.env.REIN_COURT_ADDRESS,
  enforcer: process.env.ENFORCER_ADDRESS,
};

// The appeal bond, in wei of GenLayer's native token. The Enforcer enforces its
// own floor; this is what the app posts. Operators sign in with an email and
// hold no GenLayer account, so the relayer escrows the bond as their custodian
// and the contract returns it to whichever account paid.
const APPEAL_BOND_WEI = BigInt(process.env.APPEAL_BOND_WEI || "10000000000000000");

// What the agent is allowed to spend through the host-chain session key, over
// and above the mandate's own ceiling. Zero escrow means the delegation is
// registered and revocable but holds no funds, which is the right default for a
// mandate whose allowance lives in the operator's own smart account.
const HOST_ESCROW_WEI = BigInt(process.env.HOST_ESCROW_WEI || "0");

// How many times a review may be resubmitted after GenLayer fails to reach a
// majority on it. Consensus failure is a property of the network on the day,
// not of the request, so a couple of retries is usually the difference between
// a verdict and a dead review -- but it must be bounded, or a request that can
// never succeed is retried forever.
const MAX_REVIEW_ATTEMPTS = Number(process.env.MAX_REVIEW_ATTEMPTS || 3);

// ─── Auth Middleware ─────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization header" });
    }
    const token = authHeader.replace("Bearer ", "");
    const verifiedClaims = await privy.verifyAuthToken(token);
    req.userId = verifiedClaims.userId;

    // Look up or create user in DB
    const userResult = await pool.query(
      "SELECT * FROM users WHERE privy_did = $1",
      [verifiedClaims.userId]
    );
    if (userResult.rows.length > 0) {
      req.user = userResult.rows[0];
      await pool.query(
        "UPDATE users SET last_login = NOW() WHERE privy_did = $1",
        [verifiedClaims.userId]
      );
    }
    next();
  } catch (err) {
    console.error("[Auth] Verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── User Routes ─────────────────────────────────────────────────────────────

app.post("/api/users/register", requireAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const result = await pool.query(
      `INSERT INTO users (privy_did, email)
       VALUES ($1, $2)
       ON CONFLICT (privy_did) DO UPDATE SET email = $2, last_login = NOW()
       RETURNING *`,
      [req.userId, email]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("[Users] Registration error:", err.message);
    res.status(500).json({ error: "Failed to register user" });
  }
});

app.get("/api/users/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE privy_did = $1",
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ─── Mandate Routes ──────────────────────────────────────────────────────────

app.post("/api/mandates", requireAuth, async (req, res) => {
  try {
    const {
      delegator,
      agent_address,
      mandate_text,
      spend_ceiling_wei,
      chain_id,
      session_key_id,
    } = req.body;

    if (!delegator || !agent_address || !mandate_text) {
      return res
        .status(400)
        .json({ error: "delegator, agent_address, and mandate_text are required" });
    }
    if (!session_key_id) {
      return res.status(400).json({
        error:
          "session_key_id is required: it is the host-chain key REIN revokes, " +
          "and a mandate without one cannot be enforced",
      });
    }
    if (!hostRegistryAddress()) {
      return res.status(503).json({
        error:
          "hostRegistryAddress() is not configured, so a revocation could " +
          "not be enforced. Deploy the host contract first (npm run deploy:host).",
      });
    }
    // The court can only fetch evidence for the chain the delegation runs on,
    // and the guardian can only revoke on the chain the registry is deployed to.
    const chain = String(chain_id || hostChainId());
    if (chain !== String(hostChainId())) {
      return res.status(400).json({
        error: `This deployment enforces on chain ${hostChainId()}; a mandate on chain ${chain} could not be revoked`,
      });
    }

    // Register on GenLayer first: the delegation_id it assigns is what both
    // chains key the delegation by.
    const { txHash } = await writeContract(
      CONTRACTS.mandateRegistry,
      "register_mandate",
      [
        delegator,
        agent_address,
        mandate_text,
        spend_ceiling_wei || "0",
        chain,
        session_key_id,
        hostRegistryAddress(),
      ],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );

    // Read back the mandate to get the delegation_id the contract assigned.
    const latestMandate = await waitForState(
      () => readContract(CONTRACTS.mandateRegistry, "get_all_mandates", []),
      (all) =>
        Array.isArray(all)
          ? all
              .filter(
                (m) =>
                  m?.agent_address?.toLowerCase() ===
                    agent_address.toLowerCase() &&
                  m?.mandate_text === mandate_text
              )
              .pop()
          : null
    );

    if (!latestMandate) {
      return res.status(504).json({
        error:
          "Mandate was broadcast but has not reached consensus yet. It will appear once the network settles.",
        genlayer_tx_hash: txHash,
      });
    }

    const delegationId = latestMandate.delegation_id;

    // Open the matching delegation on the host chain. Until this exists there
    // is no authority to revoke, so the mandate is stored as PENDING_HOST and
    // the UI can say so rather than implying it is enforceable.
    let hostOpen = null;
    let hostError = null;
    try {
      hostOpen = await hostOpenDelegation({
        delegationId,
        agentAddress: agent_address,
        sessionKey: session_key_id,
        ceilingWei: spend_ceiling_wei || "0",
        escrowWei: HOST_ESCROW_WEI.toString(),
      });
    } catch (err) {
      hostError = err.message;
      console.error("[Mandates] Host-chain open failed:", err.message);
    }

    const result = await pool.query(
      `INSERT INTO mandates (
        delegation_id, delegator, agent_address, mandate_text, mandate_hash,
        spend_ceiling_wei, chain_id, session_key_id, status,
        genlayer_tx_hash, genlayer_contract_address, user_email,
        host_registry, host_delegation_id, host_open_tx_hash, host_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (delegation_id) DO UPDATE SET
        status = EXCLUDED.status,
        host_open_tx_hash = EXCLUDED.host_open_tx_hash,
        host_status = EXCLUDED.host_status,
        updated_at = NOW()
      RETURNING *`,
      [
        delegationId,
        delegator,
        agent_address,
        mandate_text,
        latestMandate.mandate_hash || "",
        spend_ceiling_wei || "0",
        chain,
        session_key_id,
        "ACTIVE",
        txHash,
        CONTRACTS.mandateRegistry,
        req.user?.email || "",
        hostRegistryAddress(),
        latestMandate.host_delegation_id || delegationHandle(delegationId),
        hostOpen?.hash || null,
        hostOpen?.mined && hostOpen.status === 1 ? "OPEN" : "PENDING",
      ]
    );

    res.json({
      mandate: result.rows[0],
      genlayer_tx_hash: txHash,
      host_chain: {
        ...hostChainInfo(),
        delegation_handle:
          latestMandate.host_delegation_id || delegationHandle(delegationId),
        open_tx_hash: hostOpen?.hash || null,
        error: hostError,
      },
    });
  } catch (err) {
    console.error("[Mandates] Create error:", err.message);
    res.status(500).json({ error: `Failed to create mandate: ${err.message}` });
  }
});

app.get("/api/mandates", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM mandates WHERE user_email = $1 ORDER BY created_at DESC",
      [req.user?.email || ""]
    );
    res.json({ mandates: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch mandates" });
  }
});

app.get("/api/mandates/:delegationId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM mandates WHERE delegation_id = $1",
      [req.params.delegationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Mandate not found" });
    }
    res.json({ mandate: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch mandate" });
  }
});

// ─── Action Review Routes ────────────────────────────────────────────────────

// Reviewing an action runs an LLM through GenLayer consensus, which measured
// 52-89s end to end. That exceeds the function ceiling on most serverless
// hosts, so the request only broadcasts the transaction and returns. The
// client then polls the status route until the verdict lands on chain.
app.post("/api/actions/review", requireAuth, async (req, res) => {
  try {
    const { delegation_id, tx_hash, action_description } = req.body;

    if (!delegation_id || !tx_hash) {
      return res
        .status(400)
        .json({ error: "delegation_id and tx_hash are required" });
    }

    const mandateResult = await pool.query(
      "SELECT * FROM mandates WHERE delegation_id = $1",
      [delegation_id]
    );
    if (mandateResult.rows.length === 0) {
      return res.status(404).json({ error: "Mandate not found" });
    }
    const mandate = mandateResult.rows[0];

    const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO actions (action_id, delegation_id, tx_hash, chain_id, action_description, submitted_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'REVIEWING')`,
      [
        actionId,
        delegation_id,
        tx_hash,
        mandate.chain_id,
        action_description || "",
        req.user?.email || "",
      ]
    );

    // The court takes a delegation and a transaction hash. It reads the
    // mandate, the agent and the chain from MandateRegistry itself, so nothing
    // this service believes about the delegation can influence the verdict.
    // Passing mandate.mandate_text here, as this route used to, meant the
    // judgement was made against whatever was in our own database.
    const { txHash: glTxHash } = await writeContract(
      CONTRACTS.reinCourt,
      "review_action",
      [delegation_id, tx_hash, action_description || ""],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );

    await pool.query(
      "UPDATE actions SET genlayer_tx_hash = $1 WHERE action_id = $2",
      [glTxHash, actionId]
    );

    res.json({
      action_id: actionId,
      status: "REVIEWING",
      verdict: null,
      revocation: null,
      genlayer_tx_hash: glTxHash,
    });
  } catch (err) {
    console.error("[Review] Error:", err.message);
    res.status(500).json({ error: `Review failed: ${err.message}` });
  }
});

/**
 * Drive one revocation forward by at most one step.
 *
 * Enforcement is four moves and two chains: rule on GenLayer, submit the
 * revocation on the host chain, wait for it to mine, then have the Enforcer
 * read the receipt back. Each is slow enough that doing them in one request
 * would exceed a serverless function's ceiling, so a poll advances the state
 * machine by a single step and returns. The authoritative state is always the
 * Enforcer's own record, never this table.
 *
 * host_state runs: PENDING_VERDICT -> PENDING_HOST -> HOST_SUBMITTED ->
 * CONFIRMING -> REVOKED.
 */
async function advanceRevocation(row) {
  const { revocation_id, delegation_id, verdict_id, host_state } = row;

  if (host_state === "REVOKED") return row;

  // Step 2: the ruling is recorded on GenLayer. Find it and submit the real
  // host-chain revocation.
  if (host_state === "PENDING_HOST") {
    const onChain = await readContract(CONTRACTS.enforcer, "get_revocation_by_verdict", [
      verdict_id,
    ]).catch(() => null);
    if (!onChain?.revocation_id) return row;

    await pool.query(
      `UPDATE revocations SET revocation_id = $1, status = 'PENDING_HOST_REVOCATION'
       WHERE revocation_id = $2`,
      [onChain.revocation_id, revocation_id]
    );

    if (!hostChainConfigured()) {
      console.warn("[Enforcer] Host chain not configured; cannot enforce revocation");
      return { ...row, revocation_id: onChain.revocation_id };
    }

    let submitted = null;
    try {
      submitted = await hostRevokeDelegation({ delegationId: delegation_id, verdictId: verdict_id });
    } catch (err) {
      // A revoke that reverts because the delegation is already revoked means a
      // previous attempt landed and the hash was lost between sending it and
      // writing it down. Recover the hash from the event rather than giving up:
      // the Enforcer confirms against a transaction hash, so without one a
      // revocation that really happened could never be recorded.
      console.error("[Enforcer] Host revoke failed:", err.message);
      const recovered = await findStateChangeTx(delegation_id, "DelegationRevoked").catch(
        () => null
      );
      if (!recovered) {
        return { ...row, revocation_id: onChain.revocation_id };
      }
      console.log(`[Enforcer] Recovered revocation tx ${recovered.hash} from its event`);
      submitted = { hash: recovered.hash };
    }

    await pool.query(
      `UPDATE revocations SET host_state = 'HOST_SUBMITTED', evm_tx_hash = $1
       WHERE revocation_id = $2`,
      [submitted.hash, onChain.revocation_id]
    );
    return {
      ...row,
      revocation_id: onChain.revocation_id,
      host_state: "HOST_SUBMITTED",
      evm_tx_hash: submitted.hash,
    };
  }

  // Step 3: once the host-chain transaction is mined, ask the Enforcer to
  // verify it. It re-derives the event topic, the delegation handle and the
  // expected state itself, so this is a request to check, not an assertion.
  if (host_state === "HOST_SUBMITTED") {
    const mined = await hostTxMined(row.evm_tx_hash);
    if (!mined.mined) return row;
    if (!mined.success) {
      // A failed revoke is not a revocation. Clear the hash so the next poll
      // submits a fresh one rather than confirming a transaction that reverted.
      await pool.query(
        `UPDATE revocations SET host_state = 'PENDING_HOST', evm_tx_hash = NULL
         WHERE revocation_id = $1`,
        [revocation_id]
      );
      return { ...row, host_state: "PENDING_HOST", evm_tx_hash: null };
    }

    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "confirm_host_revocation",
      [revocation_id, row.evm_tx_hash],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );
    await pool.query(
      `UPDATE revocations SET host_state = 'CONFIRMING', confirm_tx_hash = $1
       WHERE revocation_id = $2`,
      [txHash, revocation_id]
    );
    return { ...row, host_state: "CONFIRMING", confirm_tx_hash: txHash };
  }

  // Step 4: the Enforcer's own record is what decides. Only when it says
  // REVOKED is the authority actually gone.
  if (host_state === "CONFIRMING") {
    const onChain = await readContract(CONTRACTS.enforcer, "get_revocation", [
      revocation_id,
    ]).catch(() => null);
    if (onChain?.status !== "REVOKED") return row;

    await pool.query(
      `UPDATE revocations SET host_state = 'REVOKED', status = 'REVOKED',
         evm_tx_hash = $1, evm_block_number = $2
       WHERE revocation_id = $3`,
      [onChain.evm_tx_hash || row.evm_tx_hash, onChain.evm_block_number || null, revocation_id]
    );
    await pool.query(
      `UPDATE mandates SET status = 'REVOKED', host_status = 'REVOKED', updated_at = NOW()
       WHERE delegation_id = $1`,
      [delegation_id]
    );
    return { ...row, host_state: "REVOKED", status: "REVOKED" };
  }

  return row;
}

// Poll target for a review submitted above. The contract's own state is the
// source of truth here, not the transaction status: GenLayer has been observed
// reporting CANCELED for a transaction whose writes did land, so a status check
// alone would discard a perfectly good verdict.
app.get("/api/actions/:actionId/status", requireAuth, async (req, res) => {
  try {
    const { actionId } = req.params;
    const actionResult = await pool.query(
      "SELECT * FROM actions WHERE action_id = $1",
      [actionId]
    );
    if (actionResult.rows.length === 0) {
      return res.status(404).json({ error: "Action not found" });
    }
    const action = actionResult.rows[0];

    const stored = await pool.query(
      "SELECT * FROM verdicts WHERE action_id = $1 ORDER BY created_at DESC LIMIT 1",
      [actionId]
    );

    let verdictRow = stored.rows[0] || null;

    if (!verdictRow) {
      const onChain = await readContract(
        CONTRACTS.reinCourt,
        "get_verdict_for_action",
        [action.delegation_id, action.tx_hash]
      ).catch(() => null);

      if (!onChain?.verdict_id) {
        // A review whose transaction failed consensus will never produce a
        // verdict, and from contract state alone that is indistinguishable
        // from one still being judged. Check the transaction and resubmit,
        // bounded, rather than let the client poll forever.
        const outcome = await txOutcome(action.genlayer_tx_hash);
        if (outcome.failed && (action.review_attempts || 1) < MAX_REVIEW_ATTEMPTS) {
          console.warn(
            `[Review] ${action.genlayer_tx_hash} failed consensus (${outcome.reason}); resubmitting`
          );
          const { txHash: retryHash } = await writeContract(
            CONTRACTS.reinCourt,
            "review_action",
            [action.delegation_id, action.tx_hash, action.action_description || ""],
            { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
          );
          await pool.query(
            `UPDATE actions SET genlayer_tx_hash = $1,
               review_attempts = COALESCE(review_attempts, 1) + 1
             WHERE action_id = $2`,
            [retryHash, actionId]
          );
          return res.json({
            action_id: actionId,
            status: "REVIEWING",
            verdict: null,
            revocation: null,
            consensus_retry: {
              previous_tx: action.genlayer_tx_hash,
              reason: outcome.reason,
              attempt: (action.review_attempts || 1) + 1,
            },
            genlayer_tx_hash: retryHash,
          });
        }
        if (outcome.failed) {
          await pool.query(
            "UPDATE actions SET status = 'CONSENSUS_FAILED' WHERE action_id = $1",
            [actionId]
          );
          return res.status(503).json({
            action_id: actionId,
            status: "CONSENSUS_FAILED",
            error:
              `GenLayer could not reach a majority on this review after ` +
              `${MAX_REVIEW_ATTEMPTS} attempts (${outcome.reason}). ` +
              `Nothing was recorded and the delegation is unchanged.`,
            genlayer_tx_hash: action.genlayer_tx_hash,
          });
        }
        return res.json({
          action_id: actionId,
          status: "REVIEWING",
          verdict: null,
          revocation: null,
          genlayer_tx_hash: action.genlayer_tx_hash,
        });
      }

      await pool.query(
        `INSERT INTO verdicts (
          verdict_id, delegation_id, action_id, tx_hash, verdict, severity,
          breached_clause, reasoning, confidence, genlayer_tx_hash,
          genlayer_contract_address, attributed, facts
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (verdict_id) DO NOTHING`,
        [
          onChain.verdict_id,
          action.delegation_id,
          actionId,
          action.tx_hash,
          onChain.verdict || "ambiguous",
          onChain.severity || "LOW",
          onChain.breached_clause || null,
          onChain.reasoning || "",
          onChain.confidence || 0,
          action.genlayer_tx_hash,
          CONTRACTS.reinCourt,
          Boolean(onChain.attributed),
          onChain.facts || "",
        ]
      );

      await pool.query(
        "UPDATE actions SET status = 'REVIEWED' WHERE action_id = $1",
        [actionId]
      );

      const reread = await pool.query(
        "SELECT * FROM verdicts WHERE verdict_id = $1",
        [onChain.verdict_id]
      );
      verdictRow = reread.rows[0] || null;
    }

    let revocation = null;
    if (verdictRow) {
      const revResult = await pool.query(
        "SELECT * FROM revocations WHERE verdict_id = $1 LIMIT 1",
        [verdictRow.verdict_id]
      );
      revocation = revResult.rows[0] || null;

      // Only an attributed breach at MED or above is enforceable, and the
      // Enforcer checks all three itself from the stored verdict.
      const enforceable =
        verdictRow.verdict === "breach" &&
        verdictRow.attributed &&
        ["MED", "HIGH", "CRITICAL"].includes(verdictRow.severity);

      if (enforceable && !revocation) {
        try {
          // The Enforcer is given the verdict id and reads the ruling out of the
          // court. This route used to hand it a verdict JSON assembled from our
          // own database, which meant anything that could write here could
          // revoke an agent.
          const { txHash: revTxHash } = await writeContract(
            CONTRACTS.enforcer,
            "execute_revocation",
            [verdictRow.verdict_id],
            { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
          );

          const placeholderId = `rev_pending_${verdictRow.verdict_id}`;
          await pool.query(
            `INSERT INTO revocations (
              revocation_id, delegation_id, verdict_id, severity, reason,
              status, host_state, genlayer_tx_hash
            ) VALUES ($1, $2, $3, $4, $5, 'PENDING_HOST_REVOCATION', 'PENDING_HOST', $6)
            ON CONFLICT (revocation_id) DO NOTHING`,
            [
              placeholderId,
              action.delegation_id,
              verdictRow.verdict_id,
              verdictRow.severity,
              verdictRow.reasoning || "",
              revTxHash,
            ]
          );

          // Flagged, not revoked. The authority is still live until the host
          // chain says otherwise.
          await pool.query(
            `UPDATE mandates SET status = 'FLAGGED', updated_at = NOW()
             WHERE delegation_id = $1 AND status <> 'REVOKED'`,
            [action.delegation_id]
          );

          const revRead = await pool.query(
            "SELECT * FROM revocations WHERE revocation_id = $1",
            [placeholderId]
          );
          revocation = revRead.rows[0] || null;
        } catch (revErr) {
          console.error("[Enforcer] Revocation failed:", revErr.message);
        }
      }

      if (revocation && revocation.host_state !== "REVOKED") {
        revocation = await advanceRevocation(revocation).catch((err) => {
          console.error("[Enforcer] Advance failed:", err.message);
          return revocation;
        });
      }

      if (verdictRow.verdict === "breach" && !enforceable) {
        await pool.query(
          `UPDATE mandates SET status = 'FLAGGED', updated_at = NOW()
           WHERE delegation_id = $1 AND status = 'ACTIVE'`,
          [action.delegation_id]
        );
      }
    }

    res.json({
      action_id: actionId,
      status: verdictRow ? "REVIEWED" : "REVIEWING",
      verdict: verdictRow,
      revocation,
      genlayer_tx_hash: action.genlayer_tx_hash,
    });
  } catch (err) {
    console.error("[ReviewStatus] Error:", err.message);
    res.status(500).json({ error: `Status check failed: ${err.message}` });
  }
});

// ─── Verdict Routes ──────────────────────────────────────────────────────────

app.get("/api/verdicts/:delegationId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM verdicts WHERE delegation_id = $1 ORDER BY created_at DESC",
      [req.params.delegationId]
    );
    res.json({ verdicts: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch verdicts" });
  }
});

app.get("/api/verdicts", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.*, m.mandate_text, m.agent_address
       FROM verdicts v
       JOIN mandates m ON v.delegation_id = m.delegation_id
       WHERE m.user_email = $1
       ORDER BY v.created_at DESC
       LIMIT 50`,
      [req.user?.email || ""]
    );
    res.json({ verdicts: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch verdicts" });
  }
});

// ─── Revocation Routes ──────────────────────────────────────────────────────

app.get("/api/revocations", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, m.mandate_text, m.agent_address, m.host_registry, m.chain_id
       FROM revocations r
       JOIN mandates m ON r.delegation_id = m.delegation_id
       WHERE m.user_email = $1
       ORDER BY r.created_at DESC`,
      [req.user?.email || ""]
    );
    res.json({ revocations: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch revocations" });
  }
});

// ─── Appeal Routes ───────────────────────────────────────────────────────────

app.post("/api/appeals", requireAuth, async (req, res) => {
  try {
    const { revocation_id, appeal_reason } = req.body;

    if (!revocation_id || !appeal_reason) {
      return res
        .status(400)
        .json({ error: "revocation_id and appeal_reason are required" });
    }

    const revResult = await pool.query(
      "SELECT * FROM revocations WHERE revocation_id = $1",
      [revocation_id]
    );
    if (revResult.rows.length === 0) {
      return res.status(404).json({ error: "Revocation not found" });
    }
    const rev = revResult.rows[0];

    // The Enforcer refuses an appeal against a revocation that has not actually
    // taken effect, so say why rather than broadcasting a doomed transaction.
    if (rev.host_state !== "REVOKED") {
      return res.status(409).json({
        error:
          "This revocation has not been confirmed on the host chain yet, so " +
          "there is nothing to appeal. It will become appealable once the " +
          "revocation is recorded.",
        host_state: rev.host_state,
      });
    }

    // The bond is real native value, escrowed by the contract until the appeal
    // is decided. Check we can actually pay it before promising one.
    const balance = await getRelayerBalance().catch(() => 0n);
    if (balance < APPEAL_BOND_WEI) {
      return res.status(503).json({
        error:
          `The relayer cannot fund the ${APPEAL_BOND_WEI} wei appeal bond ` +
          `(balance ${balance} wei). Top up ${relayerAddress()} to file appeals.`,
      });
    }

    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "file_appeal",
      [revocation_id, appeal_reason],
      {
        requireFinality: false,
        budgetMs: SUBMIT_BUDGET_MS,
        value: APPEAL_BOND_WEI,
      }
    );

    // Read the appeal record back out of contract state. bond_wei is what the
    // contract actually escrowed, which is the only number worth reporting.
    const latestAppeal = await waitForState(
      () => readContract(CONTRACTS.enforcer, "get_all_appeals", []),
      (all) =>
        Array.isArray(all)
          ? all.filter((a) => a?.revocation_id === revocation_id).pop()
          : null
    );

    if (!latestAppeal) {
      return res.status(504).json({
        error:
          "Appeal was broadcast but has not reached consensus yet. It will appear once the network settles.",
        genlayer_tx_hash: txHash,
      });
    }

    await pool.query(
      `INSERT INTO appeals (
        appeal_id, revocation_id, appeal_reason, bond_amount, bond_wei,
        appellant, watcher, status, genlayer_tx_hash, filed_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
      ON CONFLICT (appeal_id) DO NOTHING`,
      [
        latestAppeal.appeal_id,
        revocation_id,
        appeal_reason,
        latestAppeal.bond_wei || "0",
        latestAppeal.bond_wei || "0",
        latestAppeal.appellant || relayerAddress(),
        latestAppeal.watcher || "",
        txHash,
        req.user?.email || "",
      ]
    );

    res.json({
      appeal_id: latestAppeal.appeal_id,
      appeal: latestAppeal,
      bond_wei: latestAppeal.bond_wei,
      genlayer_tx_hash: txHash,
    });
  } catch (err) {
    console.error("[Appeals] Create error:", err.message);
    res.status(500).json({ error: `Failed to file appeal: ${err.message}` });
  }
});

// Adjudication is the second LLM path through consensus, so like review it
// only broadcasts here and is confirmed by the status route below.
app.post("/api/appeals/:appealId/adjudicate", requireAuth, async (req, res) => {
  try {
    const { appealId } = req.params;

    const appealResult = await pool.query(
      "SELECT * FROM appeals WHERE appeal_id = $1",
      [appealId]
    );
    if (appealResult.rows.length === 0) {
      return res.status(404).json({ error: "Appeal not found" });
    }

    // The Enforcer is given the appeal id and reads the registered mandate and
    // the verified transaction facts itself. This route used to pass the
    // mandate text from our database and, as the "action", the first judge's
    // own reasoning -- so the appeal re-litigated a summary of the verdict
    // instead of the thing the agent did.
    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "adjudicate_appeal",
      [appealId],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );

    await pool.query(
      `UPDATE appeals SET status = 'ADJUDICATING', genlayer_tx_hash = $1 WHERE appeal_id = $2`,
      [txHash, appealId]
    );

    res.json({
      appeal_id: appealId,
      status: "ADJUDICATING",
      adjudication: null,
      genlayer_tx_hash: txHash,
    });
  } catch (err) {
    console.error("[Appeals] Adjudicate error:", err.message);
    res.status(500).json({ error: `Adjudication failed: ${err.message}` });
  }
});

/**
 * Carry an overturned appeal through to a restored delegation.
 *
 * The mirror of advanceRevocation, and needed for the same reason: "the
 * delegation is restored to active status" is a fact about the host chain, so
 * the restore has to be submitted there and read back before anything says the
 * agent's key works again.
 */
async function advanceRestoration(appeal) {
  const { appeal_id, revocation_id, restoration_state } = appeal;
  if (restoration_state === "RESTORED") return appeal;

  const revResult = await pool.query(
    "SELECT delegation_id FROM revocations WHERE revocation_id = $1",
    [revocation_id]
  );
  const delegationId = revResult.rows[0]?.delegation_id;
  if (!delegationId) return appeal;

  if (restoration_state === "PENDING_HOST_RESTORE") {
    if (!hostChainConfigured()) return appeal;
    let submitted = null;
    try {
      submitted = await hostRestoreDelegation({ delegationId, appealId: appeal_id });
    } catch (err) {
      // Same recovery as revocation: a restore that already landed cannot be
      // sent again, and the Enforcer needs its hash to confirm it.
      console.error("[Appeals] Host restore failed:", err.message);
      const recovered = await findStateChangeTx(delegationId, "DelegationRestored").catch(
        () => null
      );
      if (!recovered) return appeal;
      console.log(`[Appeals] Recovered restoration tx ${recovered.hash} from its event`);
      submitted = { hash: recovered.hash };
    }
    await pool.query(
      `UPDATE appeals SET restoration_state = 'HOST_SUBMITTED', restoration_tx_hash = $1
       WHERE appeal_id = $2`,
      [submitted.hash, appeal_id]
    );
    return {
      ...appeal,
      restoration_state: "HOST_SUBMITTED",
      restoration_tx_hash: submitted.hash,
    };
  }

  if (restoration_state === "HOST_SUBMITTED") {
    const mined = await hostTxMined(appeal.restoration_tx_hash);
    if (!mined.mined) return appeal;
    if (!mined.success) {
      await pool.query(
        `UPDATE appeals SET restoration_state = 'PENDING_HOST_RESTORE', restoration_tx_hash = NULL
         WHERE appeal_id = $1`,
        [appeal_id]
      );
      return { ...appeal, restoration_state: "PENDING_HOST_RESTORE", restoration_tx_hash: null };
    }
    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "confirm_host_restoration",
      [appeal_id, appeal.restoration_tx_hash],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );
    await pool.query(
      `UPDATE appeals SET restoration_state = 'CONFIRMING', restoration_confirm_tx_hash = $1
       WHERE appeal_id = $2`,
      [txHash, appeal_id]
    );
    return { ...appeal, restoration_state: "CONFIRMING" };
  }

  if (restoration_state === "CONFIRMING") {
    const onChain = await readContract(CONTRACTS.enforcer, "get_appeal", [
      appeal_id,
    ]).catch(() => null);
    if (onChain?.restoration_status !== "RESTORED") return appeal;

    await pool.query(
      `UPDATE appeals SET restoration_state = 'RESTORED' WHERE appeal_id = $1`,
      [appeal_id]
    );
    await pool.query(
      `UPDATE revocations SET status = 'OVERTURNED' WHERE revocation_id = $1`,
      [revocation_id]
    );
    await pool.query(
      `UPDATE mandates SET status = 'RESTORED', host_status = 'OPEN', updated_at = NOW()
       WHERE delegation_id = $1`,
      [delegationId]
    );
    return { ...appeal, restoration_state: "RESTORED" };
  }

  return appeal;
}

app.get("/api/appeals/:appealId/status", requireAuth, async (req, res) => {
  try {
    const { appealId } = req.params;
    const appealResult = await pool.query(
      `SELECT a.*, r.delegation_id
       FROM appeals a
       JOIN revocations r ON a.revocation_id = r.revocation_id
       WHERE a.appeal_id = $1`,
      [appealId]
    );
    if (appealResult.rows.length === 0) {
      return res.status(404).json({ error: "Appeal not found" });
    }
    let appeal = appealResult.rows[0];

    const onChain = await readContract(CONTRACTS.enforcer, "get_appeal", [
      appealId,
    ]).catch(() => null);

    const resolved =
      onChain?.status && ["UPHELD", "OVERTURNED"].includes(onChain.status);

    if (!resolved) {
      return res.json({
        appeal_id: appealId,
        status: appeal.status === "ADJUDICATING" ? "ADJUDICATING" : appeal.status,
        adjudication: null,
        genlayer_tx_hash: appeal.genlayer_tx_hash,
      });
    }

    if (appeal.status !== onChain.status) {
      // The bond settlement is the contract's own record of where the money
      // went, not a status this service decided.
      await pool.query(
        `UPDATE appeals SET status = $1, adjudication_result = $2,
           bond_settlement = $3, bond_paid_to = $4,
           restoration_state = $5, resolved_at = NOW()
         WHERE appeal_id = $6`,
        [
          onChain.status,
          onChain.adjudication_result || "",
          onChain.bond_settlement || "",
          onChain.bond_paid_to || "",
          onChain.status === "OVERTURNED" ? "PENDING_HOST_RESTORE" : "NONE",
          appealId,
        ]
      );
      if (onChain.status === "UPHELD") {
        await pool.query(
          `UPDATE revocations SET status = 'UPHELD' WHERE revocation_id = $1`,
          [appeal.revocation_id]
        );
      }
      const reread = await pool.query(
        `SELECT a.*, r.delegation_id FROM appeals a
         JOIN revocations r ON a.revocation_id = r.revocation_id
         WHERE a.appeal_id = $1`,
        [appealId]
      );
      appeal = reread.rows[0] || appeal;
    }

    if (
      onChain.status === "OVERTURNED" &&
      appeal.restoration_state !== "RESTORED"
    ) {
      appeal = await advanceRestoration(appeal).catch((err) => {
        console.error("[Appeals] Restoration advance failed:", err.message);
        return appeal;
      });
    }

    res.json({
      appeal_id: appealId,
      status: onChain.status,
      adjudication: onChain,
      restoration_state: appeal.restoration_state,
      restoration_tx_hash: appeal.restoration_tx_hash,
      bond_settlement: onChain.bond_settlement,
      bond_paid_to: onChain.bond_paid_to,
      genlayer_tx_hash: appeal.genlayer_tx_hash,
    });
  } catch (err) {
    console.error("[Appeals] Status error:", err.message);
    res.status(500).json({ error: `Status check failed: ${err.message}` });
  }
});

app.get("/api/appeals", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, r.delegation_id
       FROM appeals a
       JOIN revocations r ON a.revocation_id = r.revocation_id
       JOIN mandates m ON r.delegation_id = m.delegation_id
       WHERE m.user_email = $1
       ORDER BY a.created_at DESC`,
      [req.user?.email || ""]
    );
    res.json({ appeals: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch appeals" });
  }
});

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const email = req.user?.email || "";

    const [mandates, verdicts, revocations, appeals] = await Promise.all([
      pool.query(
        "SELECT status, COUNT(*) as count FROM mandates WHERE user_email = $1 GROUP BY status",
        [email]
      ),
      pool.query(
        `SELECT v.verdict, COUNT(*) as count
         FROM verdicts v
         JOIN mandates m ON v.delegation_id = m.delegation_id
         WHERE m.user_email = $1
         GROUP BY v.verdict`,
        [email]
      ),
      pool.query(
        `SELECT COUNT(*) as count
         FROM revocations r
         JOIN mandates m ON r.delegation_id = m.delegation_id
         WHERE m.user_email = $1`,
        [email]
      ),
      pool.query(
        `SELECT a.status, COUNT(*) as count
         FROM appeals a
         JOIN revocations r ON a.revocation_id = r.revocation_id
         JOIN mandates m ON r.delegation_id = m.delegation_id
         WHERE m.user_email = $1
         GROUP BY a.status`,
        [email]
      ),
    ]);

    const mandateStats = {};
    mandates.rows.forEach((r) => (mandateStats[r.status] = parseInt(r.count)));

    const verdictStats = {};
    verdicts.rows.forEach((r) => (verdictStats[r.verdict] = parseInt(r.count)));

    res.json({
      mandates: mandateStats,
      verdicts: verdictStats,
      total_revocations: parseInt(revocations.rows[0]?.count || 0),
      appeals: appeals.rows.reduce((acc, r) => {
        acc[r.status] = parseInt(r.count);
        return acc;
      }, {}),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    contracts: CONTRACTS,
    host_chain: hostChainInfo(),
    appeal_bond_wei: APPEAL_BOND_WEI.toString(),
    relayer: relayerAddress(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * What the host chain says about one delegation, read straight from
 * ReinSessionKeyRegistry rather than from this table.
 *
 * This is the route that makes a revocation checkable by the operator: if
 * active is false, the agent's session key cannot spend, whatever any database
 * happens to say.
 */
app.get("/api/mandates/:delegationId/host", requireAuth, async (req, res) => {
  try {
    const { delegationId } = req.params;
    const owned = await pool.query(
      "SELECT delegation_id FROM mandates WHERE delegation_id = $1 AND user_email = $2",
      [delegationId, req.user?.email || ""]
    );
    if (owned.rows.length === 0) {
      return res.status(404).json({ error: "Mandate not found" });
    }
    if (!hostChainConfigured()) {
      return res.status(503).json({ error: "Host chain is not configured" });
    }

    const handle = delegationHandle(delegationId);
    const active = await hostIsActive(delegationId);
    let delegation = null;
    try {
      const { getDelegation } = await import("./hostChain.js");
      delegation = await getDelegation(delegationId);
    } catch {
      // Not opened on the host chain yet.
    }

    res.json({
      delegation_id: delegationId,
      handle,
      active,
      delegation,
      ...hostChainInfo(),
    });
  } catch (err) {
    console.error("[Host] Status error:", err.message);
    res.status(500).json({ error: `Host chain query failed: ${err.message}` });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

// Vercel (and any other serverless host) imports `app` and drives it directly.
// Only bind a port when this file is the process entrypoint.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`REIN backend running on port ${PORT}`);
    console.log(`Contract addresses:`, CONTRACTS);
  });
}

export default app;
