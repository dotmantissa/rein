# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json


def _parse_llm_json(raw: str) -> dict:
    """
    Parse a JSON object out of an LLM's answer.

    `prompt_comparative` hands back the winning validator's text verbatim, and
    models routinely wrap JSON in a markdown fence or add a sentence either side
    of it even when asked not to. Treating that as a hard failure throws away a
    verdict the validators already agreed on, so recover the object instead:
    strip any fence, then fall back to the outermost brace pair.
    """
    if isinstance(raw, dict):
        return raw

    text = str(raw).strip()

    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text[3:]
        fence = text.rfind("```")
        if fence != -1:
            text = text[:fence]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()

    try:
        parsed = json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])

    if not isinstance(parsed, dict):
        raise ValueError("expected a JSON object")
    return parsed



class Enforcer(gl.Contract):
    """
    Enforcer: holds the revocation authority.

    When ReinCourt returns a BREACH verdict at severity MED or above, the Enforcer
    records the revocation intent on GenLayer. The off-chain relayer then picks up
    the revocation event and submits the corresponding disableDelegation or
    session-key revocation transaction on the EVM chain. The resulting EVM tx hash
    is recorded back here so the loop is closed and auditable.

    The appeal path allows an agent operator to post a bond and challenge a
    revocation. A fresh validator panel re-reads the mandate and the action.
    If overturned, the delegation is restored and the bond returned.
    If upheld, the bond rewards the watcher who flagged the breach.
    """

    owner: Address
    court_address: Address
    registry_address: Address
    revocations: TreeMap[str, str]
    revocation_ids: DynArray[str]
    total_revocations: u256
    appeals: TreeMap[str, str]
    appeal_ids: DynArray[str]
    total_appeals: u256

    SEVERITY_ORDER = {"LOW": 0, "MED": 1, "HIGH": 2, "CRITICAL": 3}
    REVOCATION_THRESHOLD = 1  # MED and above trigger revocation

    def __init__(self, court_addr: str, registry_addr: str):
        self.owner = gl.message.sender_address
        self.court_address = Address(str(court_addr).strip())
        self.registry_address = Address(str(registry_addr).strip())
        self.total_revocations = u256(0)
        self.total_appeals = u256(0)

    @gl.public.write
    def execute_revocation(
        self, delegation_id: str, verdict_id: str, verdict_json: str
    ) -> str:
        """
        Execute a revocation based on a breach verdict.

        Only accepts verdicts with:
        - verdict == "breach"
        - severity >= MED

        Records the revocation intent. The off-chain relayer will pick this up
        and submit the EVM revocation transaction.
        """
        clean_del_id = str(delegation_id).strip()
        clean_verdict_id = str(verdict_id).strip()

        if not clean_del_id:
            raise gl.vm.UserError("[EXPECTED] delegation_id cannot be empty")
        if not clean_verdict_id:
            raise gl.vm.UserError("[EXPECTED] verdict_id cannot be empty")

        try:
            v_data = json.loads(str(verdict_json))
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Invalid verdict JSON")

        if v_data.get("verdict") != "breach":
            raise gl.vm.UserError(
                "[EXPECTED] Only breach verdicts can trigger revocation"
            )

        severity = v_data.get("severity", "LOW")
        sev_rank = self.SEVERITY_ORDER.get(severity, 0)
        if sev_rank < self.REVOCATION_THRESHOLD:
            raise gl.vm.UserError(
                "[EXPECTED] Severity too low for revocation. Must be MED or above."
            )

        nonce = int(self.total_revocations)
        rev_id = f"rev_{clean_del_id}_{nonce}"

        record = {
            "revocation_id": rev_id,
            "delegation_id": clean_del_id,
            "verdict_id": clean_verdict_id,
            "severity": severity,
            "breached_clause": v_data.get("breached_clause", ""),
            "reason": v_data.get("reasoning", ""),
            "status": "EXECUTED",
            "evm_tx_hash": "",
        }

        self.revocations[rev_id] = json.dumps(record, sort_keys=True)
        self.revocation_ids.append(rev_id)
        self.total_revocations = u256(nonce + 1)

        return json.dumps(record, sort_keys=True)

    @gl.public.write
    def record_evm_revocation(self, revocation_id: str, evm_tx_hash: str) -> None:
        """
        Record the EVM transaction hash for an executed revocation.
        Only the contract owner (relayer) can call this.
        Closes the audit loop between GenLayer and EVM.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(
                "[EXPECTED] Only the contract owner can record EVM revocations"
            )

        clean_rev_id = str(revocation_id).strip()
        clean_evm_tx = str(evm_tx_hash).strip()

        if clean_rev_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")

        r = json.loads(self.revocations[clean_rev_id])
        r["evm_tx_hash"] = clean_evm_tx
        self.revocations[clean_rev_id] = json.dumps(r, sort_keys=True)

    @gl.public.write
    def file_appeal(
        self, revocation_id: str, appeal_reason: str, bond_amount: str
    ) -> str:
        """
        File an appeal against a revocation.

        The agent's operator posts a bond and provides a reason why
        the revocation should be overturned. A fresh validator panel
        will re-adjudicate.
        """
        clean_rev_id = str(revocation_id).strip()
        clean_reason = str(appeal_reason).strip()
        clean_bond = str(bond_amount).strip() if bond_amount else "0"

        if not clean_rev_id:
            raise gl.vm.UserError("[EXPECTED] revocation_id cannot be empty")
        if not clean_reason:
            raise gl.vm.UserError("[EXPECTED] appeal_reason cannot be empty")
        if clean_rev_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")

        # Check revocation is still in EXECUTED state (not already appealed)
        rev = json.loads(self.revocations[clean_rev_id])
        if rev.get("status") not in ("EXECUTED",):
            raise gl.vm.UserError(
                "[EXPECTED] Revocation is not in a state that can be appealed"
            )

        nonce = int(self.total_appeals)
        appeal_id = f"apl_{clean_rev_id}_{nonce}"

        record = {
            "appeal_id": appeal_id,
            "revocation_id": clean_rev_id,
            "delegation_id": rev.get("delegation_id", ""),
            "appeal_reason": clean_reason,
            "bond_amount": clean_bond,
            "status": "PENDING",
            "adjudication_result": None,
        }

        self.appeals[appeal_id] = json.dumps(record, sort_keys=True)
        self.appeal_ids.append(appeal_id)
        self.total_appeals = u256(nonce + 1)

        return json.dumps(record, sort_keys=True)

    @gl.public.write
    def adjudicate_appeal(
        self, appeal_id: str, mandate_text: str, action_description: str
    ) -> str:
        """
        Adjudicate a pending appeal with a fresh validator panel.

        Re-reads the mandate and the original action, plus the appeal reason,
        and reaches consensus on whether to overturn or uphold the revocation.

        If OVERTURNED: delegation should be restored, bond returned to operator.
        If UPHELD: bond goes to the watcher who flagged the breach.
        """
        clean_appeal_id = str(appeal_id).strip()

        if clean_appeal_id not in self.appeals:
            raise gl.vm.UserError("[EXPECTED] Appeal not found")

        a = json.loads(self.appeals[clean_appeal_id])
        if a.get("status") != "PENDING":
            raise gl.vm.UserError(
                "[EXPECTED] Appeal is not in PENDING status"
            )

        clean_mandate = str(mandate_text).strip()
        clean_action = str(action_description).strip()
        appeal_reason = a.get("appeal_reason", "")

        def _rejudge() -> str:
            prompt = f"""You are an appeal judge for the REIN agent delegation system.

A revocation was executed against an AI agent for breaching its mandate.
The agent's operator is now appealing this revocation.

ORIGINAL MANDATE (what the agent was supposed to follow):
{clean_mandate}

ACTION THAT WAS FLAGGED:
{clean_action}

OPERATOR'S APPEAL REASON:
{appeal_reason}

Your job: determine if the original revocation should be OVERTURNED or UPHELD.

Consider:
- Was the original breach determination correct?
- Does the operator's appeal reason present valid justification?
- Was the action actually within the spirit of the mandate, even if not the letter?
- Would overturning create a dangerous precedent?

Return ONLY valid JSON:
{{"status": "OVERTURNED"|"UPHELD", "reasoning": "your detailed reasoning"}}"""

            # response_format="json" hands back a dict, not a string. This function
            # is declared -> str and its result is both calldata-encoded for the
            # leader receipt and parsed as JSON, so serialize it here.
            return json.dumps(
                gl.nondet.exec_prompt(prompt, response_format="json"),
                sort_keys=True,
            )

        # Judge the leader's ruling rather than have every validator re-run the
        # adjudication. prompt_comparative costs each validator two prompts (its
        # own ruling, then a comparison), which on StudioNet overran the
        # validator execution budget: all of them voted timeout, the leader
        # succeeded, the transaction settled as FINALIZED, and the state writes
        # were dropped with nothing in the receipt to say so.
        task = (
            "An appeal judge was asked whether a revocation should be "
            "OVERTURNED or UPHELD.\n\nMANDATE:\n"
            + clean_mandate
            + "\n\nFLAGGED ACTION:\n"
            + (clean_action if clean_action else "No description provided")
            + "\n\nOPERATOR'S APPEAL:\n"
            + (str(appeal_reason) if appeal_reason else "No reason given")
        )

        criteria = (
            "The output must be a JSON object whose 'status' is exactly "
            "\"OVERTURNED\" or \"UPHELD\", with a 'reasoning' string.\n\n"
            "Accept the output only if the reasoning engages with the mandate, "
            "the flagged action and the appeal above, and the status follows from "
            "it. Reject a ruling that contradicts its own reasoning, invents "
            "facts absent from the material above, or ignores the appeal "
            "entirely. Wording is not a reason to reject, and a defensible "
            "judgement you would have decided differently is still acceptable."
        )

        result_str = gl.eq_principle.prompt_non_comparative(
            _rejudge, task=task, criteria=criteria
        )

        # exec_prompt(response_format="json") returns a dict, which _rejudge
        # serializes. Tolerate a runner that hands back a string anyway, rather
        # than double-decoding a value that is already an object.
        try:
            result = _parse_llm_json(result_str)
            if isinstance(result, str):
                result = _parse_llm_json(result)
        except Exception:
            raise gl.vm.UserError(
                "[EXPECTED] Consensus returned invalid appeal adjudication JSON"
            )

        new_status = result.get("status", "UPHELD")
        if new_status not in ("OVERTURNED", "UPHELD"):
            new_status = "UPHELD"

        a["status"] = new_status
        a["adjudication_result"] = result.get("reasoning", "")
        self.appeals[clean_appeal_id] = json.dumps(a, sort_keys=True)

        return json.dumps(a, sort_keys=True)

    @gl.public.view
    def get_revocation(self, revocation_id: str) -> str:
        """Return a specific revocation record."""
        clean_id = str(revocation_id).strip()
        if clean_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")
        return self.revocations[clean_id]

    @gl.public.view
    def get_revocations_by_delegation(self, delegation_id: str) -> str:
        """Return all revocations for a given delegation."""
        clean_id = str(delegation_id).strip()
        records = []
        total = int(self.total_revocations)
        for i in range(total):
            rid = self.revocation_ids[i]
            if rid in self.revocations:
                try:
                    r = json.loads(self.revocations[rid])
                    if r.get("delegation_id") == clean_id:
                        records.append(r)
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_appeal(self, appeal_id: str) -> str:
        """Return a specific appeal record."""
        clean_id = str(appeal_id).strip()
        if clean_id not in self.appeals:
            raise gl.vm.UserError("[EXPECTED] Appeal not found")
        return self.appeals[clean_id]

    @gl.public.view
    def get_all_revocations(self) -> str:
        """Return all revocation records."""
        records = []
        total = int(self.total_revocations)
        for i in range(total):
            rid = self.revocation_ids[i]
            if rid in self.revocations:
                try:
                    records.append(json.loads(self.revocations[rid]))
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_all_appeals(self) -> str:
        """Return all appeal records."""
        records = []
        total = int(self.total_appeals)
        for i in range(total):
            aid = self.appeal_ids[i]
            if aid in self.appeals:
                try:
                    records.append(json.loads(self.appeals[aid]))
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_revocation_count(self) -> u256:
        """Return the total number of revocations."""
        return self.total_revocations

    @gl.public.view
    def get_appeal_count(self) -> u256:
        """Return the total number of appeals."""
        return self.total_appeals
