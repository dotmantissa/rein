# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
from genlayer.py.keccak import Keccak256
import json


def _addr_text(value) -> str:
    """
    Normalize an address to lowercase hex so two of them can be compared.

    ``gl.message.sender_address`` is an :class:`Address`, while an address read
    back out of a stored JSON record is a plain string. ``Address`` defines no
    ``__eq__`` against ``str``, so comparing the two directly is always False.
    That is why the delegator branch of ``update_status`` could never match in
    production: only the owner ever got through.
    """
    if value is None:
        return ""
    as_hex = getattr(value, "as_hex", None)
    if isinstance(as_hex, str):
        return as_hex.strip().lower()
    return str(value).strip().lower()


def _keccak_hex(text: str) -> str:
    """
    keccak256 of a UTF-8 string, as 0x-prefixed hex.

    Two things need this. The mandate commitment, which used to be Python's
    ``hash()`` -- a value that is salted per process, so the same mandate text
    produced a different "hash" on every validator and committed to nothing. And
    the host-chain delegation handle, which the Solidity registry derives as
    ``keccak256(bytes(delegation_id))``; computing it the same way here is what
    lets the two chains agree on which delegation is being talked about without
    either side being told.
    """
    hasher = Keccak256()
    hasher.update(text.encode("utf-8"))
    return "0x" + hasher.digest().hex()


def _is_evm_address(text: str) -> bool:
    if not isinstance(text, str):
        return False
    t = text.strip()
    if len(t) != 42 or not t.startswith("0x"):
        return False
    try:
        int(t[2:], 16)
    except Exception:
        return False
    return True


class MandateRegistry(gl.Contract):
    """
    MandateRegistry stores natural language delegation mandates on chain.

    When a delegator grants spending authority to an AI agent through a
    delegation framework (a session key, ERC-7710, a smart-account permission),
    the mandate describing what the agent may and may not do is registered here.
    This record is the only place ReinCourt reads a mandate from: the court is
    handed a delegation_id and nothing else, so a reviewer cannot judge an agent
    against text that was never registered.

    A record also carries the host-chain coordinates of the authority it
    governs -- the chain, the session-key registry, and the delegation handle --
    so the Enforcer knows exactly what to switch off and where to check that it
    stayed off.
    """

    owner: Address
    court: Address
    enforcer: Address
    mandates: TreeMap[str, str]
    mandate_ids: DynArray[str]
    total_mandates: u256

    VALID_STATUSES = ("ACTIVE", "FLAGGED", "REVOKED", "RESTORED")

    # A delegation whose authority is live. REVOKED is terminal until an
    # overturned appeal restores it.
    LIVE_STATUSES = ("ACTIVE", "FLAGGED", "RESTORED")

    ALLOWED_TRANSITIONS = {
        "ACTIVE": ("FLAGGED", "REVOKED"),
        "FLAGGED": ("ACTIVE", "REVOKED"),
        "REVOKED": ("RESTORED",),
        "RESTORED": ("FLAGGED", "REVOKED"),
    }

    # The chains ReinCourt can fetch verified transaction facts for. Registering
    # a mandate on a chain the court cannot read would produce a delegation that
    # is permanently unjudgeable, so it is refused at registration instead.
    SUPPORTED_CHAINS = (
        "1", "8453", "137", "42161", "11155111",
        "eth", "base", "polygon", "arbitrum", "sepolia",
    )

    def __init__(self):
        self.owner = gl.message.sender_address
        # Wired after deployment by set_court / set_enforcer, because the court
        # and the enforcer are deployed after this contract and need its address.
        self.court = gl.message.sender_address
        self.enforcer = gl.message.sender_address
        self.total_mandates = u256(0)

    # ------------------------------------------------------------------ wiring

    @gl.public.write
    def set_court(self, court_addr: str) -> None:
        """Point the registry at the ReinCourt allowed to count reviewed actions."""
        if _addr_text(gl.message.sender_address) != _addr_text(self.owner):
            raise gl.vm.UserError("[EXPECTED] Only the contract owner can set the court")
        self.court = Address(str(court_addr).strip())

    @gl.public.write
    def set_enforcer(self, enforcer_addr: str) -> None:
        """
        Point the registry at the Enforcer allowed to revoke and restore.

        Restoration is deliberately reachable from nowhere else. An operator who
        could restore their own revoked delegation would be able to veto the
        court, which is the one thing REIN exists to prevent.
        """
        if _addr_text(gl.message.sender_address) != _addr_text(self.owner):
            raise gl.vm.UserError("[EXPECTED] Only the contract owner can set the enforcer")
        self.enforcer = Address(str(enforcer_addr).strip())

    @gl.public.view
    def get_wiring(self) -> str:
        """Return the addresses this registry trusts, so they can be audited."""
        return json.dumps(
            {
                "owner": _addr_text(self.owner),
                "court": _addr_text(self.court),
                "enforcer": _addr_text(self.enforcer),
            },
            sort_keys=True,
        )

    # ------------------------------------------------------------ registration

    @gl.public.write
    def register_mandate(
        self,
        delegator: str,
        agent_address: str,
        mandate_text: str,
        spend_ceiling_wei: str,
        chain_id: str,
        session_key_id: str,
        host_registry: str,
    ) -> str:
        """
        Register a new delegation mandate. Returns the delegation_id.

        The mandate_text is the plain English contract the agent must follow and
        the text every future review is judged against. The spend_ceiling_wei is
        the deterministic hard cap REIN sits on top of. host_registry is the
        address of the host-chain session-key registry that actually holds the
        authority, which is what makes a revocation enforceable rather than
        advisory.
        """
        clean_delegator = str(delegator).strip() if delegator else ""
        clean_agent = str(agent_address).strip() if agent_address else ""
        clean_text = str(mandate_text).strip() if mandate_text else ""
        clean_ceiling = str(spend_ceiling_wei).strip() if spend_ceiling_wei else "0"
        clean_chain = str(chain_id).strip() if chain_id else "1"
        clean_session = str(session_key_id).strip() if session_key_id else ""
        clean_host = str(host_registry).strip() if host_registry else ""

        # The court binds a review to the agent by comparing the transaction's
        # sender against this field, and the Enforcer addresses the host chain
        # with these values. Garbage here is not a cosmetic problem: it makes the
        # delegation unjudgeable or unenforceable, so it is refused up front.
        if not _is_evm_address(clean_delegator):
            raise gl.vm.UserError(
                "[EXPECTED] delegator must be a 20 byte hex address"
            )
        if not _is_evm_address(clean_agent):
            raise gl.vm.UserError(
                "[EXPECTED] agent_address must be a 20 byte hex address"
            )
        if not clean_text:
            raise gl.vm.UserError("[EXPECTED] mandate_text cannot be empty")
        if clean_chain not in self.SUPPORTED_CHAINS:
            raise gl.vm.UserError(
                "[EXPECTED] Unsupported chain_id: "
                + clean_chain
                + ". ReinCourt cannot verify transactions there."
            )
        if clean_session and not _is_evm_address(clean_session):
            raise gl.vm.UserError(
                "[EXPECTED] session_key_id must be a 20 byte hex address"
            )
        if clean_host and not _is_evm_address(clean_host):
            raise gl.vm.UserError(
                "[EXPECTED] host_registry must be a 20 byte hex address"
            )
        ceiling_ok = False
        try:
            ceiling_ok = int(clean_ceiling) >= 0
        except Exception:
            ceiling_ok = False
        if not ceiling_ok:
            raise gl.vm.UserError(
                "[EXPECTED] spend_ceiling_wei must be a non-negative integer"
            )

        # The registry's own address goes into the id. Without it a
        # delegation_id is only unique within one deployment: a redeployed
        # registry starts its nonce at zero and mints
        # "del_<delegator>_<agent>_0" all over again, and since the host-chain
        # handle is keccak256 of this string, the new delegation collides with
        # the old one on the host chain. openDelegation then reverts with
        # DelegationExists and the mandate is registered but unenforceable.
        nonce = int(self.total_mandates)
        here = _addr_text(gl.message.contract_address)[2:10]
        delegation_id = (
            f"del_{here}_{clean_delegator[2:10]}_{clean_agent[2:10]}_{nonce}"
        )

        record = {
            "delegation_id": delegation_id,
            "delegator": clean_delegator.lower(),
            "agent_address": clean_agent.lower(),
            "mandate_text": clean_text,
            "mandate_hash": _keccak_hex(clean_text),
            "spend_ceiling_wei": clean_ceiling,
            "chain_id": clean_chain,
            "session_key_id": clean_session.lower(),
            "host_registry": clean_host.lower(),
            # The handle the Solidity registry keys this delegation by. Derived,
            # not supplied, so the two chains cannot be pointed at different
            # delegations by a caller.
            "host_delegation_id": _keccak_hex(delegation_id),
            "status": "ACTIVE",
            "action_count": 0,
            "registered_by": _addr_text(gl.message.sender_address),
        }

        self.mandates[delegation_id] = json.dumps(record, sort_keys=True)
        self.mandate_ids.append(delegation_id)
        self.total_mandates = u256(nonce + 1)

        return delegation_id

    # ------------------------------------------------------------------- reads

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
        clean_addr = _addr_text(delegator_address)
        records = []
        total = int(self.total_mandates)
        for i in range(total):
            did = self.mandate_ids[i]
            if did in self.mandates:
                try:
                    m = json.loads(self.mandates[did])
                    if _addr_text(m.get("delegator")) == clean_addr:
                        records.append(m)
                except Exception:
                    pass
        return json.dumps(records)

    @gl.public.view
    def get_mandate_count(self) -> u256:
        """Return the total number of registered mandates."""
        return self.total_mandates

    @gl.public.view
    def is_live(self, delegation_id: str) -> bool:
        """True while this delegation's authority has not been revoked."""
        clean_id = str(delegation_id).strip()
        if clean_id not in self.mandates:
            return False
        try:
            return json.loads(self.mandates[clean_id]).get("status") in self.LIVE_STATUSES
        except Exception:
            return False

    # ------------------------------------------------------------------ writes

    @gl.public.write
    def update_status(self, delegation_id: str, new_status: str) -> None:
        """
        Move a mandate to a new lifecycle state.

        Who may do what:

        * the Enforcer may REVOKE and is the only caller that may RESTORE,
          because restoration is the result of an overturned appeal and nothing
          else;
        * the delegator may FLAG their own agent or pull its rein themselves;
        * the owner may FLAG or clear a flag as an operational backstop.

        Nobody can lift a revocation except through the appeal path.
        """
        clean_id = str(delegation_id).strip()
        clean_status = str(new_status).strip()

        if clean_status not in self.VALID_STATUSES:
            raise gl.vm.UserError(
                f"[EXPECTED] Invalid status: {clean_status}. Must be one of: "
                + ", ".join(sorted(self.VALID_STATUSES))
            )
        if clean_id not in self.mandates:
            raise gl.vm.UserError("[EXPECTED] Mandate not found")

        m = json.loads(self.mandates[clean_id])
        current = m.get("status", "ACTIVE")

        sender = _addr_text(gl.message.sender_address)
        is_owner = sender == _addr_text(self.owner)
        is_delegator = sender == _addr_text(m.get("delegator"))
        is_enforcer = sender == _addr_text(self.enforcer)

        if clean_status == "RESTORED":
            if not is_enforcer:
                raise gl.vm.UserError(
                    "[EXPECTED] Only the Enforcer can restore a revoked delegation, "
                    "and only through an overturned appeal"
                )
        elif clean_status == "REVOKED":
            if not (is_enforcer or is_delegator or is_owner):
                raise gl.vm.UserError(
                    "[EXPECTED] Only the Enforcer, the delegator or the owner can revoke"
                )
        else:
            if not (is_owner or is_delegator or is_enforcer):
                raise gl.vm.UserError(
                    "[EXPECTED] Only the contract owner or the mandate delegator can update status"
                )

        if current == clean_status:
            return

        allowed = self.ALLOWED_TRANSITIONS.get(current, ())
        if clean_status not in allowed:
            raise gl.vm.UserError(
                f"[EXPECTED] Cannot move a mandate from {current} to {clean_status}"
            )

        m["status"] = clean_status
        self.mandates[clean_id] = json.dumps(m, sort_keys=True)

    @gl.public.write
    def increment_action_count(self, delegation_id: str) -> None:
        """
        Record that one more action was reviewed against this mandate.

        Callable by the court, which does this itself after storing a verdict,
        or by the owner.
        """
        sender = _addr_text(gl.message.sender_address)
        if sender != _addr_text(self.owner) and sender != _addr_text(self.court):
            raise gl.vm.UserError(
                "[EXPECTED] Only the court or the contract owner can increment action count"
            )

        clean_id = str(delegation_id).strip()
        if clean_id not in self.mandates:
            raise gl.vm.UserError("[EXPECTED] Mandate not found")

        m = json.loads(self.mandates[clean_id])
        m["action_count"] = int(m.get("action_count", 0)) + 1
        self.mandates[clean_id] = json.dumps(m, sort_keys=True)
