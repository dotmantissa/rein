# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json


class MandateRegistry(gl.Contract):
    """
    MandateRegistry stores natural language delegation mandates on chain.

    When a delegator grants spending authority to an AI agent through a delegation
    framework (session keys, ERC-7710, etc.), the mandate describing what the agent
    may and may not do is registered here. This text becomes the contract the agent
    is judged against by ReinCourt.
    """

    owner: Address
    mandates: TreeMap[str, str]
    mandate_ids: DynArray[str]
    total_mandates: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.total_mandates = u256(0)

    @gl.public.write
    def register_mandate(
        self,
        delegator: str,
        agent_address: str,
        mandate_text: str,
        spend_ceiling_wei: str,
        chain_id: str,
        session_key_id: str,
    ) -> str:
        """
        Register a new delegation mandate. Returns the delegation_id.

        The mandate_text is the plain English contract the agent must follow.
        The spend_ceiling_wei is the deterministic hard cap on total spend.
        """
        if not delegator or not str(delegator).strip():
            raise gl.vm.UserError("[EXPECTED] delegator address cannot be empty")
        if not agent_address or not str(agent_address).strip():
            raise gl.vm.UserError("[EXPECTED] agent_address cannot be empty")
        if not mandate_text or not str(mandate_text).strip():
            raise gl.vm.UserError("[EXPECTED] mandate_text cannot be empty")

        clean_delegator = str(delegator).strip()
        clean_agent = str(agent_address).strip()
        clean_text = str(mandate_text).strip()
        clean_ceiling = str(spend_ceiling_wei).strip() if spend_ceiling_wei else "0"
        clean_chain = str(chain_id).strip() if chain_id else "1"
        clean_session = str(session_key_id).strip() if session_key_id else ""

        nonce = int(self.total_mandates)
        delegation_id = f"del_{clean_delegator[:8]}_{clean_agent[:8]}_{nonce}"
        mandate_hash = str(hash(clean_text + clean_delegator + str(nonce)))

        record = {
            "delegation_id": delegation_id,
            "delegator": clean_delegator,
            "agent_address": clean_agent,
            "mandate_text": clean_text,
            "mandate_hash": mandate_hash,
            "spend_ceiling_wei": clean_ceiling,
            "chain_id": clean_chain,
            "session_key_id": clean_session,
            "status": "ACTIVE",
            "action_count": 0,
        }

        self.mandates[delegation_id] = json.dumps(record, sort_keys=True)
        self.mandate_ids.append(delegation_id)
        self.total_mandates = u256(nonce + 1)

        return delegation_id

    @gl.public.view
    def get_mandate(self, delegation_id: str) -> str:
        """Return the full JSON mandate record for a given delegation_id."""
        clean_id = str(delegation_id).strip()
        if clean_id not in self.mandates:
            raise gl.vm.UserError("[EXPECTED] Mandate not found")
        return self.mandates[clean_id]

    @gl.public.view
    def get_all_mandates(self) -> str:
        """Return a JSON array of all registered mandates."""
        records = []
        total = int(self.total_mandates)
        for i in range(total):
            did = self.mandate_ids[i]
            if did in self.mandates:
                try:
                    records.append(json.loads(self.mandates[did]))
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_mandates_by_delegator(self, delegator_address: str) -> str:
        """Return all mandates belonging to a specific delegator."""
        clean_addr = str(delegator_address).strip()
        records = []
        total = int(self.total_mandates)
        for i in range(total):
            did = self.mandate_ids[i]
            if did in self.mandates:
                try:
                    m = json.loads(self.mandates[did])
                    if m.get("delegator") == clean_addr:
                        records.append(m)
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_mandate_count(self) -> u256:
        """Return the total number of registered mandates."""
        return self.total_mandates

    @gl.public.write
    def update_status(self, delegation_id: str, new_status: str) -> None:
        """
        Update the status of a mandate.
        Only the contract owner or the mandate's delegator may do this.
        Valid statuses: ACTIVE, FLAGGED, REVOKED, RESTORED.
        """
        clean_id = str(delegation_id).strip()
        clean_status = str(new_status).strip()

        valid_statuses = {"ACTIVE", "FLAGGED", "REVOKED", "RESTORED"}
        if clean_status not in valid_statuses:
            raise gl.vm.UserError(
                f"[EXPECTED] Invalid status: {clean_status}. Must be one of: {', '.join(sorted(valid_statuses))}"
            )

        if clean_id not in self.mandates:
            raise gl.vm.UserError("[EXPECTED] Mandate not found")

        m = json.loads(self.mandates[clean_id])
        sender = gl.message.sender_address

        if sender != self.owner and sender != m.get("delegator"):
            raise gl.vm.UserError(
                "[EXPECTED] Only the contract owner or the mandate delegator can update status"
            )

        m["status"] = clean_status
        self.mandates[clean_id] = json.dumps(m, sort_keys=True)

    @gl.public.write
    def increment_action_count(self, delegation_id: str) -> None:
        """
        Increment the reviewed action count for a mandate.
        Only callable by the contract owner (called by the court after each review).
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("[EXPECTED] Only the contract owner can increment action count")

        clean_id = str(delegation_id).strip()
        if clean_id not in self.mandates:
            raise gl.vm.UserError("[EXPECTED] Mandate not found")

        m = json.loads(self.mandates[clean_id])
        m["action_count"] = m.get("action_count", 0) + 1
        self.mandates[clean_id] = json.dumps(m, sort_keys=True)
