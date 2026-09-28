# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json


class ReinCourt(gl.Contract):
    """
    ReinCourt: the semantic judge.

    When review_action is called, the court reads the mandate the agent was given,
    fetches the transaction the agent executed from a public block explorer,
    and uses GenLayer's LLM consensus to decide whether that action breached any
    clause of the mandate.

    Validators independently fetch from DIFFERENT explorers (Etherscan, Basescan,
    Blockscout) and re-run the semantic judgement. The equivalence principle ensures
    that a verdict is only accepted when validators agree on the core determination
    (breach or not) while tolerating minor differences in severity assessment.
    """

    owner: Address
    registry_address: Address
    verdicts: TreeMap[str, str]
    verdict_ids: DynArray[str]
    total_verdicts: u256

    EXPLORER_URLS = {
        "1": [
            "https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://eth.blockscout.com/api/v2/transactions/",
        ],
        "eth": [
            "https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://eth.blockscout.com/api/v2/transactions/",
        ],
        "8453": [
            "https://api.basescan.org/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://base.blockscout.com/api/v2/transactions/",
        ],
        "base": [
            "https://api.basescan.org/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://base.blockscout.com/api/v2/transactions/",
        ],
        "11155111": [
            "https://api-sepolia.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://eth-sepolia.blockscout.com/api/v2/transactions/",
        ],
        "sepolia": [
            "https://api-sepolia.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=",
            "https://eth-sepolia.blockscout.com/api/v2/transactions/",
        ],
    }

    SEVERITY_ORDER = {"LOW": 0, "MED": 1, "HIGH": 2, "CRITICAL": 3}

    def __init__(self, registry_addr: str):
        self.owner = gl.message.sender_address
        self.registry_address = str(registry_addr).strip()
        self.total_verdicts = u256(0)

    @gl.public.write
    def review_action(
        self,
        delegation_id: str,
        tx_hash: str,
        chain_id: str,
        action_description: str,
        mandate_text: str,
    ) -> str:
        """
        Core judgement function.

        1. Fetch the transaction from a public block explorer
        2. Semantically judge compliance against the mandate
        3. Reach validator consensus via the equivalence principle
        4. Store and return the verdict

        The verdict includes: compliant/breach/ambiguous, severity band,
        the specific breached clause (if any), reasoning, and confidence.
        """
        clean_del_id = str(delegation_id).strip()
        clean_tx = str(tx_hash).strip()
        clean_chain = str(chain_id).strip()
        clean_desc = str(action_description).strip()
        clean_mandate = str(mandate_text).strip()

        if not clean_del_id:
            raise gl.vm.UserError("[EXPECTED] delegation_id cannot be empty")
        if not clean_tx:
            raise gl.vm.UserError("[EXPECTED] tx_hash cannot be empty")
        if not clean_mandate:
            raise gl.vm.UserError("[EXPECTED] mandate_text cannot be empty")

        def _judge() -> str:
            # Select explorer URL based on chain ID
            # Validators will naturally use different explorer endpoints
            # because the nondet web calls are independently executed
            urls = self.EXPLORER_URLS.get(clean_chain, [
                f"https://eth.blockscout.com/api/v2/transactions/"
            ])

            # Try primary explorer
            tx_data_raw = ""
            for url_base in urls:
                try:
                    resp = gl.nondet.web.get(url_base + clean_tx)
                    if resp and len(str(resp)) > 10:
                        tx_data_raw = str(resp)[:4000]
                        break
                except Exception:
                    continue

            if not tx_data_raw:
                tx_data_raw = "Transaction data unavailable from explorers"

            prompt = f"""You are a compliance judge for an AI agent delegation system called REIN.

An AI agent was given the following mandate by its delegator:

MANDATE:
{clean_mandate}

The agent executed a transaction. Here are the details:

TRANSACTION DATA (from block explorer):
{tx_data_raw}

ACTION DESCRIPTION (from the submitter):
{clean_desc if clean_desc else "No description provided"}

Your job: determine whether this transaction breaches ANY clause of the mandate.

Rules:
- If the action clearly falls within what the mandate allows, verdict is "compliant"
- If the action clearly violates a specific clause, verdict is "breach"
- If the mandate is too vague to determine, or the evidence is insufficient, verdict is "ambiguous"
- Severity: LOW (minor deviation), MED (moderate violation), HIGH (significant breach), CRITICAL (catastrophic, e.g. sending to known scam)
- For "compliant" verdicts, severity should be "LOW" and breached_clause should be null
- Be specific about which clause was breached

Return ONLY valid JSON:
{{"verdict": "compliant"|"breach"|"ambiguous", "severity": "LOW"|"MED"|"HIGH"|"CRITICAL", "breached_clause": "the exact clause text that was breached"|null, "reasoning": "your detailed reasoning", "confidence": 0.0 to 1.0}}"""

            return gl.nondet.exec_prompt(prompt, response_format="json")

        comparison_prompt = """Compare the validator outputs for mandate compliance adjudication.

STRICT MATCHING (must agree exactly):
1. "verdict" field: must be identical ("compliant", "breach", or "ambiguous")
2. "breached_clause" field: must be semantically identical (same clause referenced)

MANDATORY AGREEMENT:
- If one validator says "breach" and another says "compliant", this is a DISAGREEMENT and cannot be reconciled

TOLERANT MATCHING (allowed to differ slightly):
- "severity" field: may differ by ONE adjacent band (e.g. MED vs HIGH is ok, LOW vs CRITICAL is not)
- "confidence" field: may differ by up to 0.2
- "reasoning" field: may differ in wording as long as the conclusion is the same

When outputs agree, prefer the result with:
1. Higher confidence score
2. More detailed reasoning
3. If severity differs by one band, use the HIGHER severity (err on the side of caution)"""

        verdict_json = gl.eq_principle.prompt_comparative(_judge, comparison_prompt)

        try:
            v_data = json.loads(verdict_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Consensus returned invalid verdict JSON")

        # Validate verdict structure
        verdict_val = v_data.get("verdict", "")
        if verdict_val not in ("compliant", "breach", "ambiguous"):
            raise gl.vm.UserError("[EXPECTED] Invalid verdict value")

        severity_val = v_data.get("severity", "LOW")
        if severity_val not in self.SEVERITY_ORDER:
            severity_val = "LOW"

        nonce = int(self.total_verdicts)
        verdict_id = f"vrd_{clean_del_id}_{nonce}"

        verdict_record = {
            "verdict_id": verdict_id,
            "delegation_id": clean_del_id,
            "tx_hash": clean_tx,
            "chain_id": clean_chain,
            "verdict": verdict_val,
            "severity": severity_val,
            "breached_clause": v_data.get("breached_clause"),
            "reasoning": v_data.get("reasoning", ""),
            "confidence": v_data.get("confidence", 0.0),
        }

        self.verdicts[verdict_id] = json.dumps(verdict_record, sort_keys=True)
        self.verdict_ids.append(verdict_id)
        self.total_verdicts = u256(nonce + 1)

        return json.dumps(verdict_record, sort_keys=True)

    @gl.public.view
    def get_verdict(self, verdict_id: str) -> str:
        """Return a specific verdict by its ID."""
        clean_id = str(verdict_id).strip()
        if clean_id not in self.verdicts:
            raise gl.vm.UserError("[EXPECTED] Verdict not found")
        return self.verdicts[clean_id]

    @gl.public.view
    def get_verdicts_by_delegation(self, delegation_id: str) -> str:
        """Return all verdicts for a given delegation."""
        clean_id = str(delegation_id).strip()
        records = []
        total = int(self.total_verdicts)
        for i in range(total):
            vid = self.verdict_ids[i]
            if vid in self.verdicts:
                try:
                    v = json.loads(self.verdicts[vid])
                    if v.get("delegation_id") == clean_id:
                        records.append(v)
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_recent_verdicts(self, limit: u256) -> str:
        """Return the most recent verdicts up to the specified limit."""
        total = int(self.total_verdicts)
        lim = int(limit)
        if lim <= 0:
            lim = 10
        start = max(0, total - lim)
        records = []
        for i in range(total - 1, start - 1, -1):
            vid = self.verdict_ids[i]
            if vid in self.verdicts:
                try:
                    records.append(json.loads(self.verdicts[vid]))
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_verdict_count(self) -> u256:
        """Return the total number of verdicts issued."""
        return self.total_verdicts
