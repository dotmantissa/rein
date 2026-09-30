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
} from "./genlayerRelayer.js";

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

    // Write to GenLayer contract
    const { txHash } = await writeContract(
      CONTRACTS.mandateRegistry,
      "register_mandate",
      [
        delegator,
        agent_address,
        mandate_text,
        spend_ceiling_wei || "0",
        chain_id || "1",
        session_key_id || "",
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

    const delegationId = latestMandate?.delegation_id || `del_${Date.now()}`;

    // Persist to database
    const result = await pool.query(
      `INSERT INTO mandates (
        delegation_id, delegator, agent_address, mandate_text, mandate_hash,
        spend_ceiling_wei, chain_id, session_key_id, status,
        genlayer_tx_hash, genlayer_contract_address, user_email
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (delegation_id) DO UPDATE SET
        status = EXCLUDED.status, updated_at = NOW()
      RETURNING *`,
      [
        delegationId,
        delegator,
        agent_address,
        mandate_text,
        latestMandate?.mandate_hash || "",
        spend_ceiling_wei || "0",
        chain_id || "1",
        session_key_id || "",
        "ACTIVE",
        txHash,
        CONTRACTS.mandateRegistry,
        req.user?.email || "",
      ]
    );

    res.json({
      mandate: result.rows[0],
      genlayer_tx_hash: txHash,
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
    const { delegation_id, tx_hash, chain_id, action_description } = req.body;

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
        chain_id || mandate.chain_id || "1",
        action_description || "",
        req.user?.email || "",
      ]
    );

    const { txHash: glTxHash } = await writeContract(
      CONTRACTS.reinCourt,
      "review_action",
      [
        delegation_id,
        tx_hash,
        chain_id || mandate.chain_id || "1",
        action_description || "",
        mandate.mandate_text,
      ],
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
        "get_verdicts_by_delegation",
        [action.delegation_id]
      ).catch(() => []);

      const match = Array.isArray(onChain)
        ? onChain.filter((v) => v?.tx_hash === action.tx_hash).pop()
        : null;

      if (!match) {
        return res.json({
          action_id: actionId,
          status: "REVIEWING",
          verdict: null,
          revocation: null,
          genlayer_tx_hash: action.genlayer_tx_hash,
        });
      }

      const verdictId =
        match.verdict_id || `vrd_${actionId}`;

      await pool.query(
        `INSERT INTO verdicts (
          verdict_id, delegation_id, action_id, tx_hash, verdict, severity,
          breached_clause, reasoning, confidence, genlayer_tx_hash, genlayer_contract_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (verdict_id) DO NOTHING`,
        [
          verdictId,
          action.delegation_id,
          actionId,
          action.tx_hash,
          match.verdict || "ambiguous",
          match.severity || "LOW",
          match.breached_clause || null,
          match.reasoning || "",
          match.confidence || 0,
          action.genlayer_tx_hash,
          CONTRACTS.reinCourt,
        ]
      );

      await pool.query(
        "UPDATE actions SET status = 'REVIEWED' WHERE action_id = $1",
        [actionId]
      );

      const reread = await pool.query(
        "SELECT * FROM verdicts WHERE verdict_id = $1",
        [verdictId]
      );
      verdictRow = reread.rows[0] || null;
    }

    // Enforcement is driven off the verdict, and is itself a consensus write,
    // so it is fired once and confirmed on a later poll rather than awaited.
    let revocation = null;
    if (verdictRow) {
      const revResult = await pool.query(
        "SELECT * FROM revocations WHERE verdict_id = $1 LIMIT 1",
        [verdictRow.verdict_id]
      );
      revocation = revResult.rows[0] || null;

      const enforceable =
        verdictRow.verdict === "breach" &&
        ["MED", "HIGH", "CRITICAL"].includes(verdictRow.severity);

      if (enforceable && !revocation) {
        try {
          const { txHash: revTxHash } = await writeContract(
            CONTRACTS.enforcer,
            "execute_revocation",
            [
              action.delegation_id,
              verdictRow.verdict_id,
              JSON.stringify({
                verdict: verdictRow.verdict,
                severity: verdictRow.severity,
                reasoning: verdictRow.reasoning,
                breached_clause: verdictRow.breached_clause,
              }),
            ],
            { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
          );

          const revId = `rev_${verdictRow.verdict_id}`;
          await pool.query(
            `INSERT INTO revocations (revocation_id, delegation_id, verdict_id, severity, reason, status, genlayer_tx_hash)
             VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
             ON CONFLICT (revocation_id) DO NOTHING`,
            [
              revId,
              action.delegation_id,
              verdictRow.verdict_id,
              verdictRow.severity,
              verdictRow.reasoning || "",
              revTxHash,
            ]
          );

          await pool.query(
            "UPDATE mandates SET status = 'REVOKED', updated_at = NOW() WHERE delegation_id = $1",
            [action.delegation_id]
          );

          const revRead = await pool.query(
            "SELECT * FROM revocations WHERE revocation_id = $1",
            [revId]
          );
          revocation = revRead.rows[0] || null;
        } catch (revErr) {
          console.error("[Enforcer] Auto-revocation failed:", revErr.message);
        }
      } else if (revocation && revocation.status === "PENDING") {
        const onChainRevs = await readContract(
          CONTRACTS.enforcer,
          "get_revocations_by_delegation",
          [action.delegation_id]
        ).catch(() => []);
        const confirmed = Array.isArray(onChainRevs)
          ? onChainRevs.some((r) => r?.verdict_id === verdictRow.verdict_id)
          : false;
        if (confirmed) {
          await pool.query(
            "UPDATE revocations SET status = 'EXECUTED' WHERE revocation_id = $1",
            [revocation.revocation_id]
          );
          revocation = { ...revocation, status: "EXECUTED" };
        }
      }

      if (verdictRow.verdict === "breach" && !enforceable) {
        await pool.query(
          "UPDATE mandates SET status = 'FLAGGED', updated_at = NOW() WHERE delegation_id = $1",
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
      `SELECT r.*, m.mandate_text, m.agent_address
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
    const { revocation_id, appeal_reason, bond_amount } = req.body;

    if (!revocation_id || !appeal_reason) {
      return res
        .status(400)
        .json({ error: "revocation_id and appeal_reason are required" });
    }

    // Submit appeal to Enforcer contract
    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "file_appeal",
      [revocation_id, appeal_reason, bond_amount || "0"],
      { requireFinality: false, budgetMs: SUBMIT_BUDGET_MS }
    );

    // Read the appeal record back out of contract state.
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

    const appealId =
      latestAppeal?.appeal_id ||
      `apl_${Date.now()}`;

    // Get the revocation to find the delegation
    const revResult = await pool.query(
      "SELECT * FROM revocations WHERE revocation_id = $1",
      [revocation_id]
    );

    await pool.query(
      `INSERT INTO appeals (appeal_id, revocation_id, appeal_reason, bond_amount, status, genlayer_tx_hash, filed_by)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
       ON CONFLICT (appeal_id) DO NOTHING`,
      [appealId, revocation_id, appeal_reason, bond_amount || "0", txHash, req.user?.email || ""]
    );

    res.json({
      appeal_id: appealId,
      appeal: latestAppeal,
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
      `SELECT a.*, r.delegation_id, r.verdict_id
       FROM appeals a
       JOIN revocations r ON a.revocation_id = r.revocation_id
       WHERE a.appeal_id = $1`,
      [appealId]
    );

    if (appealResult.rows.length === 0) {
      return res.status(404).json({ error: "Appeal not found" });
    }

    const appeal = appealResult.rows[0];

    const mandateResult = await pool.query(
      "SELECT mandate_text FROM mandates WHERE delegation_id = $1",
      [appeal.delegation_id]
    );
    const mandateText = mandateResult.rows[0]?.mandate_text || "";

    const verdictResult = await pool.query(
      "SELECT * FROM verdicts WHERE verdict_id = $1",
      [appeal.verdict_id]
    );
    const actionDesc = verdictResult.rows[0]?.reasoning || "";

    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "adjudicate_appeal",
      [appealId, mandateText, actionDesc],
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
    const appeal = appealResult.rows[0];

    if (appeal.status !== "ADJUDICATING") {
      return res.json({
        appeal_id: appealId,
        status: appeal.status,
        adjudication: appeal.adjudication_result || null,
        genlayer_tx_hash: appeal.genlayer_tx_hash,
      });
    }

    const adjResult = await readContract(CONTRACTS.enforcer, "get_appeal", [
      appealId,
    ]).catch(() => null);

    const resolved =
      adjResult?.status && ["UPHELD", "OVERTURNED"].includes(adjResult.status);

    if (!resolved) {
      return res.json({
        appeal_id: appealId,
        status: "ADJUDICATING",
        adjudication: null,
        genlayer_tx_hash: appeal.genlayer_tx_hash,
      });
    }

    await pool.query(
      `UPDATE appeals SET status = $1, adjudication_result = $2, resolved_at = NOW()
       WHERE appeal_id = $3`,
      [adjResult.status, adjResult.adjudication_result || "", appealId]
    );

    if (adjResult.status === "OVERTURNED") {
      await pool.query(
        "UPDATE mandates SET status = 'RESTORED', updated_at = NOW() WHERE delegation_id = $1",
        [appeal.delegation_id]
      );
    }

    res.json({
      appeal_id: appealId,
      status: adjResult.status,
      adjudication: adjResult,
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
    timestamp: new Date().toISOString(),
  });
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
