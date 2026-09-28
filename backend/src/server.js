/**
 * REIN Backend Server
 *
 * Express API that bridges the Next.js frontend to GenLayer contracts
 * and the Neon PostgreSQL database. Handles Privy authentication,
 * transaction abstraction, and the complete mandate lifecycle.
 */

import dotenv from "dotenv";
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
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
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
      ]
    );

    // Read back the mandate to get the delegation_id
    const allMandates = await readContract(
      CONTRACTS.mandateRegistry,
      "get_all_mandates",
      []
    );

    const latestMandate = Array.isArray(allMandates)
      ? allMandates[allMandates.length - 1]
      : null;

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

app.post("/api/actions/review", requireAuth, async (req, res) => {
  try {
    const { delegation_id, tx_hash, chain_id, action_description } = req.body;

    if (!delegation_id || !tx_hash) {
      return res
        .status(400)
        .json({ error: "delegation_id and tx_hash are required" });
    }

    // Get the mandate text
    const mandateResult = await pool.query(
      "SELECT * FROM mandates WHERE delegation_id = $1",
      [delegation_id]
    );
    if (mandateResult.rows.length === 0) {
      return res.status(404).json({ error: "Mandate not found" });
    }
    const mandate = mandateResult.rows[0];

    // Create action record
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

    // Submit to ReinCourt for review
    const { txHash: glTxHash } = await writeContract(
      CONTRACTS.reinCourt,
      "review_action",
      [
        delegation_id,
        tx_hash,
        chain_id || mandate.chain_id || "1",
        action_description || "",
        mandate.mandate_text,
      ]
    );

    // Read the verdict from the contract
    const recentVerdicts = await readContract(
      CONTRACTS.reinCourt,
      "get_verdicts_by_delegation",
      [delegation_id]
    );

    const latestVerdict = Array.isArray(recentVerdicts)
      ? recentVerdicts[recentVerdicts.length - 1]
      : null;

    // Store verdict in DB
    const verdictId =
      latestVerdict?.verdict_id ||
      `vrd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await pool.query(
      `INSERT INTO verdicts (
        verdict_id, delegation_id, action_id, tx_hash, verdict, severity,
        breached_clause, reasoning, confidence, genlayer_tx_hash, genlayer_contract_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (verdict_id) DO NOTHING`,
      [
        verdictId,
        delegation_id,
        actionId,
        tx_hash,
        latestVerdict?.verdict || "ambiguous",
        latestVerdict?.severity || "LOW",
        latestVerdict?.breached_clause || null,
        latestVerdict?.reasoning || "",
        latestVerdict?.confidence || 0,
        glTxHash,
        CONTRACTS.reinCourt,
      ]
    );

    // Update action status
    await pool.query(
      "UPDATE actions SET status = 'REVIEWED', genlayer_tx_hash = $1 WHERE action_id = $2",
      [glTxHash, actionId]
    );

    // If breach with severity >= MED, auto-trigger revocation
    const verdict = latestVerdict?.verdict;
    const severity = latestVerdict?.severity;
    let revocation = null;

    if (
      verdict === "breach" &&
      ["MED", "HIGH", "CRITICAL"].includes(severity)
    ) {
      try {
        const { txHash: revTxHash } = await writeContract(
          CONTRACTS.enforcer,
          "execute_revocation",
          [delegation_id, verdictId, JSON.stringify(latestVerdict)]
        );

        // Read revocation record
        const allRevocations = await readContract(
          CONTRACTS.enforcer,
          "get_revocations_by_delegation",
          [delegation_id]
        );

        const latestRev = Array.isArray(allRevocations)
          ? allRevocations[allRevocations.length - 1]
          : null;

        const revId =
          latestRev?.revocation_id ||
          `rev_${Date.now()}`;

        await pool.query(
          `INSERT INTO revocations (revocation_id, delegation_id, verdict_id, severity, reason, status, genlayer_tx_hash)
           VALUES ($1, $2, $3, $4, $5, 'EXECUTED', $6)
           ON CONFLICT (revocation_id) DO NOTHING`,
          [revId, delegation_id, verdictId, severity, latestVerdict?.reasoning || "", revTxHash]
        );

        // Update mandate status
        await pool.query(
          "UPDATE mandates SET status = 'REVOKED', updated_at = NOW() WHERE delegation_id = $1",
          [delegation_id]
        );

        revocation = latestRev;
      } catch (revErr) {
        console.error("[Enforcer] Auto-revocation failed:", revErr.message);
      }
    } else if (verdict === "breach") {
      // Low severity breach: flag but don't revoke
      await pool.query(
        "UPDATE mandates SET status = 'FLAGGED', updated_at = NOW() WHERE delegation_id = $1",
        [delegation_id]
      );
    }

    res.json({
      action_id: actionId,
      verdict: latestVerdict,
      revocation,
      genlayer_tx_hash: glTxHash,
    });
  } catch (err) {
    console.error("[Review] Error:", err.message);
    res.status(500).json({ error: `Review failed: ${err.message}` });
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
      [revocation_id, appeal_reason, bond_amount || "0"]
    );

    // Read appeal record
    const allAppeals = await readContract(
      CONTRACTS.enforcer,
      "get_all_appeals",
      []
    );
    const latestAppeal = Array.isArray(allAppeals)
      ? allAppeals[allAppeals.length - 1]
      : null;

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

app.post("/api/appeals/:appealId/adjudicate", requireAuth, async (req, res) => {
  try {
    const { appealId } = req.params;

    // Get the appeal and related data
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

    // Get mandate text for re-adjudication
    const mandateResult = await pool.query(
      "SELECT mandate_text FROM mandates WHERE delegation_id = $1",
      [appeal.delegation_id]
    );

    const mandateText = mandateResult.rows[0]?.mandate_text || "";

    // Get the original action description
    const verdictResult = await pool.query(
      "SELECT * FROM verdicts WHERE verdict_id = $1",
      [appeal.verdict_id]
    );

    const actionDesc = verdictResult.rows[0]?.reasoning || "";

    // Submit to Enforcer for adjudication
    const { txHash } = await writeContract(
      CONTRACTS.enforcer,
      "adjudicate_appeal",
      [appealId, mandateText, actionDesc]
    );

    // Read result
    const adjResult = await readContract(
      CONTRACTS.enforcer,
      "get_appeal",
      [appealId]
    );

    const newStatus = adjResult?.status || "UPHELD";

    // Update DB
    await pool.query(
      `UPDATE appeals SET status = $1, adjudication_result = $2, genlayer_tx_hash = $3, resolved_at = NOW()
       WHERE appeal_id = $4`,
      [newStatus, adjResult?.adjudication_result || "", txHash, appealId]
    );

    // If overturned, restore the mandate
    if (newStatus === "OVERTURNED") {
      await pool.query(
        "UPDATE mandates SET status = 'RESTORED', updated_at = NOW() WHERE delegation_id = $1",
        [appeal.delegation_id]
      );
    }

    res.json({
      appeal_id: appealId,
      status: newStatus,
      adjudication: adjResult,
      genlayer_tx_hash: txHash,
    });
  } catch (err) {
    console.error("[Appeals] Adjudicate error:", err.message);
    res.status(500).json({ error: `Adjudication failed: ${err.message}` });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`REIN backend running on port ${PORT}`);
  console.log(`Contract addresses:`, CONTRACTS);
});
