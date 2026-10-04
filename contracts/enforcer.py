# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
from genlayer.py.keccak import Keccak256
import json


SEVERITY_ORDER = {"LOW": 0, "MED": 1, "HIGH": 2, "CRITICAL": 3}

# Public JSON-RPC endpoints for the chains a delegation's authority can live on.
# Held as a constant for the same reason the court holds its explorer list: a
# caller-supplied endpoint would let whoever submits the confirmation choose the
# node that answers, and a revocation would only ever be as true as that node.
HOST_RPC_URLS = {
    "1": [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
    ],
    "eth": ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    "11155111": [
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.drpc.org",
    ],
    "sepolia": [
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.drpc.org",
    ],
    "8453": ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
    "base": ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
    "137": ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    "polygon": ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    "42161": ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    "arbitrum": ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
}

# Signatures of the host-chain surface this contract authenticates against. The
# hashes are derived at call time rather than pasted in, so renaming an event in
# ReinSessionKeyRegistry.sol cannot leave a stale constant here that silently
# matches nothing.
REVOKED_EVENT_SIG = "DelegationRevoked(bytes32,bytes32,address)"
RESTORED_EVENT_SIG = "DelegationRestored(bytes32,bytes32,address)"
IS_ACTIVE_FN_SIG = "isActive(bytes32)"


def _addr_text(value) -> str:
    """Normalize an address to lowercase hex so two of them can be compared."""
    if value is None:
        return ""
    as_hex = getattr(value, "as_hex", None)
    if isinstance(as_hex, str):
        return as_hex.strip().lower()
    return str(value).strip().lower()


def _keccak_hex(text: str) -> str:
    hasher = Keccak256()
    hasher.update(text.encode("utf-8"))
    return "0x" + hasher.digest().hex()


def _parse_llm_json(raw) -> dict:
    """
    Parse a JSON object out of an LLM's answer.

    Models routinely wrap JSON in a markdown fence or add a sentence either side
    of it even when asked not to. Treating that as a hard failure throws away a
    usable ruling, so recover the object instead: strip any fence, then fall back
    to the outermost brace pair.
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


def _llm_json(prompt: str, who: str) -> dict:
    """
    Run a prompt and parse its answer, or fail in a way the network understands.

    A bare Python exception inside a nondeterministic block is not recoverable
    in GenVM: it takes the whole VM down, and StudioNet reports that as a
    non-classifiable internal error with no stack trace. ``exec_prompt`` can
    answer ``None``, and ``str(None)`` is not JSON, so an unwrapped parse is one
    empty model response away from a dead transaction. ``[LLM_ERROR]`` makes
    validators disagree and rotates the leader instead, which is the documented
    handling for a misbehaving model.
    """
    raw = gl.nondet.exec_prompt(prompt, response_format="json")
    if raw is None:
        raise gl.vm.UserError("[LLM_ERROR] " + who + " returned no answer")
    try:
        return _parse_llm_json(raw)
    except gl.vm.UserError:
        raise
    except Exception:
        raise gl.vm.UserError(
            "[LLM_ERROR] " + who + " returned an answer that is not JSON: "
            + str(raw)[:160]
        )


def _hex32(value: str) -> str:
    """Left-pad a hex quantity to a 32 byte word, lowercase, 0x prefixed."""
    t = str(value or "").strip().lower()
    if t.startswith("0x"):
        t = t[2:]
    return "0x" + t.rjust(64, "0")


def _topic_eq(a, b) -> bool:
    return _hex32(a) == _hex32(b)


def _is_zero_word(value: str) -> bool:
    """True when an eth_call result decodes to false / zero."""
    t = str(value or "").strip().lower()
    if t.startswith("0x"):
        t = t[2:]
    if not t:
        return False
    try:
        return int(t, 16) == 0
    except Exception:
        return False


class Enforcer(gl.Contract):
    """
    Enforcer: holds the revocation authority.

    The honest shape of enforcement here is two steps, and this contract will
    not collapse them.

    First, a breach verdict is authenticated. ``execute_revocation`` is given a
    verdict_id and nothing else: it reads the verdict out of ReinCourt, reads
    the mandate out of MandateRegistry, and checks they still agree about the
    agent and the mandate text before accepting that the verdict justifies
    pulling the rein. A caller cannot hand over a verdict of their own making.

    Second, the host-chain effect is proven. A revocation is recorded as
    PENDING_HOST_REVOCATION, and the relayer submits the real
    ``revoke(bytes32,bytes32)`` transaction to the ReinSessionKeyRegistry that
    holds the agent's session key. Only when ``confirm_host_revocation`` has
    read that transaction's receipt back over JSON-RPC -- matching the contract,
    the event, the delegation handle, and a subsequent ``isActive`` of false --
    does the revocation become REVOKED and the mandate lose its authority. The
    transaction hash and block are recorded on chain, so the claim is auditable
    rather than asserted.

    The appeal path mirrors it. The operator posts a real bond with
    ``file_appeal``, which is payable, and a fresh panel re-reads the registered
    mandate and the verified facts the original verdict was reached on. If the
    appeal is upheld the bond goes to the watcher who flagged the breach; if it
    is overturned the bond is returned and the delegation is restored -- again
    only once the host-chain ``restore`` has been read back.
    """

    owner: Address
    court_address: Address
    registry_address: Address
    revocations: TreeMap[str, str]
    revocation_ids: DynArray[str]
    # verdict_id -> revocation_id. One verdict justifies one revocation.
    revoked_verdicts: TreeMap[str, str]
    total_revocations: u256
    appeals: TreeMap[str, str]
    appeal_ids: DynArray[str]
    total_appeals: u256

    SEVERITY_ORDER = SEVERITY_ORDER
    REVOCATION_THRESHOLD = 1  # MED and above trigger revocation

    # An appeal has to cost something, or it is just a request for a second
    # opinion with no downside. Denominated in wei of the native token and paid
    # with the call.
    MIN_BOND_WEI = 10**16

    def __init__(self, court_addr: str, registry_addr: str):
        self.owner = gl.message.sender_address
        self.court_address = Address(str(court_addr).strip())
        self.registry_address = Address(str(registry_addr).strip())
        self.total_revocations = u256(0)
        self.total_appeals = u256(0)

    # ------------------------------------------------------------------ reads

    @gl.public.view
    def get_wiring(self) -> str:
        """The contracts this enforcer trusts, and the bond it requires."""
        return json.dumps(
            {
                "owner": _addr_text(self.owner),
                "court": _addr_text(self.court_address),
                "registry": _addr_text(self.registry_address),
                "min_bond_wei": str(self.MIN_BOND_WEI),
            },
            sort_keys=True,
        )

    def _load_mandate(self, delegation_id: str) -> dict:
        registry = gl.get_contract_at(self.registry_address)
        try:
            raw = registry.view().get_mandate(str(delegation_id).strip())
        except Exception:
            raise gl.vm.UserError(
                "[EXPECTED] Delegation " + str(delegation_id) + " is not registered"
            )
        try:
            mandate = json.loads(str(raw))
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Registry returned an unreadable mandate")
        if not isinstance(mandate, dict):
            raise gl.vm.UserError("[EXPECTED] Registry returned an unreadable mandate")
        return mandate

    def _load_verdict(self, verdict_id: str) -> dict:
        court = gl.get_contract_at(self.court_address)
        try:
            raw = court.view().get_verdict(str(verdict_id).strip())
        except Exception:
            raise gl.vm.UserError(
                "[EXPECTED] Verdict "
                + str(verdict_id)
                + " does not exist in the court of record"
            )
        try:
            verdict = json.loads(str(raw))
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Court returned an unreadable verdict")
        if not isinstance(verdict, dict):
            raise gl.vm.UserError("[EXPECTED] Court returned an unreadable verdict")
        return verdict

    # ------------------------------------------------------------ enforcement

    @gl.public.write
    def execute_revocation(self, verdict_id: str) -> str:
        """
        Act on a breach verdict that ReinCourt actually issued.

        The verdict is fetched from the court by id. Nothing about it is taken
        from the caller, which is the point: the previous version accepted the
        verdict JSON as an argument, so anyone able to call this contract could
        write their own breach finding and have an agent's authority pulled on
        the strength of it.

        Accepts only a verdict that

        * the court has stored under this id,
        * reached "breach" at MED severity or above,
        * was attributed to the agent the mandate names, and
        * still matches the registered mandate it was issued against.

        Recorded as PENDING_HOST_REVOCATION. The authority is not gone until
        confirm_host_revocation has seen the host chain say so.
        """
        clean_verdict_id = str(verdict_id).strip()
        if not clean_verdict_id:
            raise gl.vm.UserError("[EXPECTED] verdict_id cannot be empty")

        if clean_verdict_id in self.revoked_verdicts:
            existing = self.revoked_verdicts[clean_verdict_id]
            if existing in self.revocations:
                # A retried broadcast must not revoke twice.
                return self.revocations[existing]

        v_data = self._load_verdict(clean_verdict_id)

        if v_data.get("verdict") != "breach":
            raise gl.vm.UserError(
                "[EXPECTED] Only breach verdicts can trigger revocation"
            )

        severity = str(v_data.get("severity", "LOW"))
        sev_rank = SEVERITY_ORDER.get(severity, 0)
        if sev_rank < self.REVOCATION_THRESHOLD:
            raise gl.vm.UserError(
                "[EXPECTED] Severity too low for revocation. Must be MED or above."
            )

        if not v_data.get("attributed"):
            raise gl.vm.UserError(
                "[EXPECTED] This verdict was not attributed to the registered agent, "
                "so it cannot support a revocation"
            )

        clean_del_id = str(v_data.get("delegation_id", "")).strip()
        if not clean_del_id:
            raise gl.vm.UserError("[EXPECTED] Verdict names no delegation")

        mandate = self._load_mandate(clean_del_id)

        # The verdict was bound to an agent and a mandate text when it was
        # issued. If either has moved since, the verdict is about a delegation
        # that no longer exists in that form and must not be acted on.
        if _addr_text(v_data.get("agent_address")) != _addr_text(
            mandate.get("agent_address")
        ):
            raise gl.vm.UserError(
                "[EXPECTED] Verdict was issued against a different agent than the "
                "one this delegation now names"
            )
        if str(v_data.get("mandate_hash", "")) != str(mandate.get("mandate_hash", "")):
            raise gl.vm.UserError(
                "[EXPECTED] The mandate has changed since this verdict was issued"
            )

        status = str(mandate.get("status", ""))
        if status == "REVOKED":
            raise gl.vm.UserError(
                "[EXPECTED] Delegation " + clean_del_id + " is already revoked"
            )

        host_registry = _addr_text(mandate.get("host_registry"))
        host_delegation_id = str(mandate.get("host_delegation_id", "")).strip().lower()
        chain_id = str(mandate.get("chain_id", "")).strip()

        if not host_registry:
            raise gl.vm.UserError(
                "[EXPECTED] This delegation records no host-chain session key registry, "
                "so there is no authority to revoke"
            )
        if chain_id not in HOST_RPC_URLS:
            raise gl.vm.UserError(
                "[EXPECTED] No host-chain RPC configured for chain " + chain_id
            )

        nonce = int(self.total_revocations)
        rev_id = f"rev_{clean_del_id}_{nonce}"

        record = {
            "revocation_id": rev_id,
            "delegation_id": clean_del_id,
            "verdict_id": clean_verdict_id,
            "agent_address": _addr_text(mandate.get("agent_address")),
            "severity": severity,
            "breached_clause": v_data.get("breached_clause", ""),
            "reason": v_data.get("reasoning", ""),
            # Who flagged it, and therefore who earns the bond if the operator
            # appeals and loses.
            "watcher": _addr_text(v_data.get("submitted_by")),
            "status": "PENDING_HOST_REVOCATION",
            "chain_id": chain_id,
            "host_registry": host_registry,
            "host_delegation_id": host_delegation_id,
            # What the relayer must submit on the host chain, spelled out so the
            # revocation is reproducible by anyone reading this record.
            "host_action": "revoke(bytes32,bytes32)",
            "host_verdict_ref": _keccak_hex(clean_verdict_id),
            "evm_tx_hash": "",
            "evm_block_number": "",
            "confirmed_by": "",
            "restoration_status": "NONE",
            "restoration_tx_hash": "",
        }

        self.revocations[rev_id] = json.dumps(record, sort_keys=True)
        self.revocation_ids.append(rev_id)
        self.revoked_verdicts[clean_verdict_id] = rev_id
        self.total_revocations = u256(nonce + 1)

        # The court has ruled, so the mandate is flagged immediately. It is not
        # marked REVOKED until the host chain has actually stopped the key.
        if status in ("ACTIVE", "RESTORED"):
            try:
                gl.get_contract_at(self.registry_address).emit(
                    on="finalized"
                ).update_status(clean_del_id, "FLAGGED")
            except Exception:
                pass

        return json.dumps(record, sort_keys=True)

    @gl.public.write
    def confirm_host_revocation(self, revocation_id: str, evm_tx_hash: str) -> str:
        """
        Prove the host-chain revocation landed, then mark the delegation revoked.

        This is the step the project previously claimed and did not have. The
        old contract wrote status EXECUTED the moment a verdict arrived and left
        evm_tx_hash as an empty string that nothing ever filled in, so "REIN
        trustlessly revokes spending authority on-chain" rested on a field that
        was always blank.

        Here the transaction is read back from the host chain's JSON-RPC under a
        strict equivalence principle, and all of the following must hold before
        anything is marked revoked:

        * the receipt exists and succeeded,
        * it was sent to the session-key registry this delegation records,
        * it emitted DelegationRevoked for this delegation's handle, and
        * isActive() for that handle now answers false.

        A mined receipt is immutable, so every validator reads the same bytes.
        """
        clean_rev_id = str(revocation_id).strip()
        clean_evm_tx = str(evm_tx_hash).strip().lower()

        if clean_rev_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")
        if not clean_evm_tx.startswith("0x") or len(clean_evm_tx) != 66:
            raise gl.vm.UserError("[EXPECTED] evm_tx_hash must be a 32 byte hex hash")

        r = json.loads(self.revocations[clean_rev_id])
        if r.get("status") == "REVOKED":
            return json.dumps(r, sort_keys=True)
        if r.get("status") != "PENDING_HOST_REVOCATION":
            raise gl.vm.UserError(
                "[EXPECTED] Revocation "
                + clean_rev_id
                + " is "
                + str(r.get("status"))
                + " and is not awaiting host-chain confirmation"
            )

        proof = self._verify_host_event(
            chain_id=str(r.get("chain_id", "")),
            host_registry=str(r.get("host_registry", "")),
            host_delegation_id=str(r.get("host_delegation_id", "")),
            evm_tx_hash=clean_evm_tx,
            event_sig=REVOKED_EVENT_SIG,
            expect_active=False,
        )

        r["status"] = "REVOKED"
        r["evm_tx_hash"] = clean_evm_tx
        r["evm_block_number"] = str(proof.get("block_number", ""))
        r["confirmed_by"] = _addr_text(gl.message.sender_address)
        self.revocations[clean_rev_id] = json.dumps(r, sort_keys=True)

        # The authority is actually gone now, so the registry can say so.
        try:
            gl.get_contract_at(self.registry_address).emit(
                on="finalized"
            ).update_status(str(r.get("delegation_id", "")), "REVOKED")
        except Exception:
            pass

        return json.dumps(r, sort_keys=True)

    def _verify_host_event(
        self,
        chain_id: str,
        host_registry: str,
        host_delegation_id: str,
        evm_tx_hash: str,
        event_sig: str,
        expect_active: bool,
    ) -> dict:
        """
        Read a host-chain receipt and the resulting state, or refuse.

        Everything checked here is fixed once the transaction is mined, so the
        leader and every validator see identical bytes and strict equality is
        the right principle. The returned dict is what they compare.
        """
        rpc_urls = HOST_RPC_URLS.get(str(chain_id).strip())
        if not rpc_urls:
            raise gl.vm.UserError(
                "[EXPECTED] No host-chain RPC configured for chain " + str(chain_id)
            )

        registry_addr = _addr_text(host_registry)
        handle = _hex32(host_delegation_id)
        topic0 = _keccak_hex(event_sig)
        selector = _keccak_hex(IS_ACTIVE_FN_SIG)[:10]
        call_data = selector + handle[2:]
        tx = evm_tx_hash
        want_active = bool(expect_active)

        def _read() -> dict:
            receipt = None
            active_word = None
            for url in rpc_urls:
                try:
                    resp = gl.nondet.web.post(
                        url,
                        body=json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 1,
                                "method": "eth_getTransactionReceipt",
                                "params": [tx],
                            }
                        ),
                        headers={"Content-Type": "application/json"},
                    )
                except Exception:
                    continue
                if resp is None:
                    continue
                status_code = int(getattr(resp, "status", 0) or 0)
                body = getattr(resp, "body", None)
                if not body or status_code < 200 or status_code >= 300:
                    continue
                try:
                    payload = json.loads(
                        bytes(body[:262144]).decode("utf-8", errors="replace")
                    )
                except Exception:
                    continue
                candidate = payload.get("result") if isinstance(payload, dict) else None
                if not isinstance(candidate, dict):
                    continue

                # Same endpoint, same request: ask it for the state too, so a
                # node that is behind cannot pass a receipt and then be dodged
                # for the state check.
                try:
                    state_resp = gl.nondet.web.post(
                        url,
                        body=json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "eth_call",
                                "params": [
                                    {"to": registry_addr, "data": call_data},
                                    "latest",
                                ],
                            }
                        ),
                        headers={"Content-Type": "application/json"},
                    )
                except Exception:
                    continue
                if state_resp is None:
                    continue
                state_code = int(getattr(state_resp, "status", 0) or 0)
                state_body = getattr(state_resp, "body", None)
                if not state_body or state_code < 200 or state_code >= 300:
                    continue
                try:
                    state_payload = json.loads(
                        bytes(state_body[:8192]).decode("utf-8", errors="replace")
                    )
                except Exception:
                    continue
                word = (
                    state_payload.get("result")
                    if isinstance(state_payload, dict)
                    else None
                )
                if not isinstance(word, str):
                    continue

                receipt = candidate
                active_word = word
                break

            if receipt is None or active_word is None:
                raise gl.vm.UserError(
                    "[TRANSIENT] Host chain did not answer for transaction " + tx
                )

            if str(receipt.get("status", "")).strip().lower() not in ("0x1", "1"):
                raise gl.vm.UserError(
                    "[EXPECTED] Host-chain transaction " + tx + " did not succeed"
                )
            if _addr_text(receipt.get("to")) != registry_addr:
                raise gl.vm.UserError(
                    "[EXPECTED] Host-chain transaction "
                    + tx
                    + " was not sent to this delegation's session key registry"
                )

            matched = None
            for log in receipt.get("logs", []) or []:
                if not isinstance(log, dict):
                    continue
                if _addr_text(log.get("address")) != registry_addr:
                    continue
                topics = log.get("topics") or []
                if len(topics) < 2:
                    continue
                if not _topic_eq(topics[0], topic0):
                    continue
                if not _topic_eq(topics[1], handle):
                    continue
                matched = log
                break

            if matched is None:
                raise gl.vm.UserError(
                    "[EXPECTED] Host-chain transaction "
                    + tx
                    + " does not carry the expected event for this delegation"
                )

            is_active = not _is_zero_word(active_word)
            if is_active != want_active:
                raise gl.vm.UserError(
                    "[EXPECTED] Host chain reports the delegation as "
                    + ("active" if is_active else "inactive")
                    + ", which is not the state this confirmation claims"
                )

            return {
                "block_number": str(matched.get("blockNumber", "")),
                "log_index": str(matched.get("logIndex", "")),
                "tx_hash": str(matched.get("transactionHash", tx)).lower(),
                "active": "true" if is_active else "false",
            }

        return gl.eq_principle.strict_eq(_read)

    @gl.public.write
    def record_evm_revocation(self, revocation_id: str, evm_tx_hash: str) -> None:
        """
        Retained for callers written against the previous ABI.

        It no longer writes an unverified hash into the record: it runs the same
        host-chain confirmation as confirm_host_revocation, because an
        owner-asserted transaction hash was exactly the thing that made the
        revocation claim unfalsifiable.
        """
        if _addr_text(gl.message.sender_address) != _addr_text(self.owner):
            raise gl.vm.UserError(
                "[EXPECTED] Only the contract owner can record EVM revocations"
            )
        self.confirm_host_revocation(revocation_id, evm_tx_hash)

    # ----------------------------------------------------------------- appeals

    @gl.public.write.payable
    def file_appeal(self, revocation_id: str, appeal_reason: str) -> str:
        """
        File an appeal against a revocation, posting the bond with the call.

        The bond is the value sent to this function, held by this contract until
        the appeal is decided. It used to be a string argument that nothing
        collected and nothing paid out, which made both halves of the published
        appeal economics -- bond returned on an overturn, bond to the watcher on
        an upheld revocation -- claims about nothing.

        Only the delegator named in the mandate, or the relayer acting as their
        custodian, may appeal. The bond is returned to whichever account paid it.
        """
        clean_rev_id = str(revocation_id).strip()
        clean_reason = str(appeal_reason).strip() if appeal_reason else ""
        bond = int(gl.message.value or 0)

        if not clean_rev_id:
            raise gl.vm.UserError("[EXPECTED] revocation_id cannot be empty")
        if not clean_reason:
            raise gl.vm.UserError("[EXPECTED] appeal_reason cannot be empty")
        if clean_rev_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")

        rev = json.loads(self.revocations[clean_rev_id])

        # Only a revocation that actually took effect can be appealed. Appealing
        # one that is still waiting on its host-chain confirmation would be
        # appealing something that has not happened.
        if rev.get("status") != "REVOKED":
            raise gl.vm.UserError(
                "[EXPECTED] Revocation is "
                + str(rev.get("status"))
                + " and is not in a state that can be appealed"
            )
        if str(rev.get("restoration_status", "NONE")) != "NONE":
            raise gl.vm.UserError(
                "[EXPECTED] This revocation has already been appealed"
            )

        if bond < int(self.MIN_BOND_WEI):
            raise gl.vm.UserError(
                "[EXPECTED] Appeal bond must be at least "
                + str(self.MIN_BOND_WEI)
                + " wei, sent with the call. Received "
                + str(bond)
            )

        mandate = self._load_mandate(str(rev.get("delegation_id", "")))
        sender = _addr_text(gl.message.sender_address)
        if sender != _addr_text(mandate.get("delegator")) and sender != _addr_text(
            self.owner
        ):
            raise gl.vm.UserError(
                "[EXPECTED] Only the delegator, or the relayer acting on their "
                "behalf, can appeal this revocation"
            )

        nonce = int(self.total_appeals)
        appeal_id = f"apl_{clean_rev_id}_{nonce}"

        record = {
            "appeal_id": appeal_id,
            "revocation_id": clean_rev_id,
            "delegation_id": rev.get("delegation_id", ""),
            "verdict_id": rev.get("verdict_id", ""),
            "appeal_reason": clean_reason,
            # The amount actually escrowed by this contract, not an amount
            # somebody typed.
            "bond_wei": str(bond),
            "bond_amount": str(bond),
            "appellant": sender,
            "on_behalf_of": _addr_text(mandate.get("delegator")),
            "watcher": rev.get("watcher", ""),
            "status": "PENDING",
            "adjudication_result": None,
            "bond_settlement": "ESCROWED",
            "bond_paid_to": "",
            "restoration_status": "NONE",
        }

        self.appeals[appeal_id] = json.dumps(record, sort_keys=True)
        self.appeal_ids.append(appeal_id)
        self.total_appeals = u256(nonce + 1)

        rev["restoration_status"] = "APPEALED"
        self.revocations[clean_rev_id] = json.dumps(rev, sort_keys=True)

        return json.dumps(record, sort_keys=True)

    @gl.public.write
    def adjudicate_appeal(self, appeal_id: str) -> str:
        """
        Re-decide a revocation on the record, with a fresh validator panel.

        The panel is given the mandate as registered and the verified
        transaction facts the original verdict was reached on, both read from
        the other two contracts. Previously the mandate text and a description
        of the action were arguments, and the backend was passing the first
        judge's own reasoning in as "the action" -- so the appeal re-litigated a
        summary of the verdict rather than the thing the agent did.

        Deciding also settles the bond. An overturned appeal returns it and puts
        the delegation up for restoration; an upheld one pays it to the watcher
        who flagged the breach.
        """
        clean_appeal_id = str(appeal_id).strip()
        if clean_appeal_id not in self.appeals:
            raise gl.vm.UserError("[EXPECTED] Appeal not found")

        a = json.loads(self.appeals[clean_appeal_id])
        if a.get("status") != "PENDING":
            raise gl.vm.UserError("[EXPECTED] Appeal is not in PENDING status")

        v_data = self._load_verdict(str(a.get("verdict_id", "")))
        mandate = self._load_mandate(str(a.get("delegation_id", "")))

        clean_mandate = str(mandate.get("mandate_text", "")).strip()
        verified_facts = str(v_data.get("facts", "")).strip()
        original_clause = str(v_data.get("breached_clause") or "").strip()
        original_reasoning = str(v_data.get("reasoning") or "").strip()
        original_severity = str(v_data.get("severity") or "").strip()
        appeal_reason = str(a.get("appeal_reason", ""))
        tx_hash = str(v_data.get("tx_hash", ""))
        chain_id = str(v_data.get("chain_id", ""))

        if not clean_mandate:
            raise gl.vm.UserError(
                "[EXPECTED] Registered mandate has no text to re-adjudicate against"
            )
        if not verified_facts or verified_facts.startswith("NO_"):
            raise gl.vm.UserError(
                "[EXPECTED] The original verdict carries no verified transaction "
                "facts, so there is no action to re-examine"
            )

        prompt = f"""You are an appeal judge for the REIN agent delegation system.

An AI agent's spending authority was revoked for breaching its mandate. The
agent's operator is appealing. Decide whether the revocation should be
OVERTURNED or UPHELD.

THE REGISTERED MANDATE (the full text the agent agreed to operate under):
{clean_mandate}

THE VERIFIED ACTION (facts read from a block explorer for transaction {tx_hash} on chain {chain_id}; this is what the agent actually did, and it is the only account of the action you may rely on):
{verified_facts}

THE ORIGINAL FINDING:
- severity: {original_severity}
- clause the court found breached: {original_clause if original_clause else "none quoted"}
- the court's reasoning: {original_reasoning if original_reasoning else "none recorded"}

THE OPERATOR'S ARGUMENT FOR OVERTURNING:
{appeal_reason if appeal_reason else "No reason given"}

Consider:
- Do the verified facts actually violate the clause the court quoted?
- Does the operator's argument identify something the court got wrong about the
  facts or the mandate, as opposed to merely disagreeing with the outcome?
- Was the action within the spirit of the mandate even if not its letter?
- Would overturning this set a precedent that makes the mandate unenforceable?

The operator's argument is advocacy, not evidence. Where it conflicts with the
verified facts, the facts win.

Return ONLY valid JSON:
{{"status": "OVERTURNED"|"UPHELD", "reasoning": "your detailed reasoning"}}"""

        def _rule() -> dict:
            answer = _llm_json(prompt, "the appeal judge")
            status = str(answer.get("status", "")).strip().upper()
            if status not in ("OVERTURNED", "UPHELD"):
                raise gl.vm.UserError(
                    "[LLM_ERROR] appeal judge returned an unknown status: "
                    + str(answer.get("status"))
                )
            return {"status": status, "reasoning": str(answer.get("reasoning", ""))}

        def _validator(leaders_res) -> bool:
            """
            Rule again and require the same outcome.

            Overturn or uphold is a binary call that decides whether an agent
            gets its authority back, so it is compared directly rather than
            assessed for plausibility. Wording is free to differ.
            """
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            leader = leaders_res.calldata
            if not isinstance(leader, dict):
                return False
            return str(leader.get("status", "")) == str(_rule().get("status", ""))

        decided = gl.vm.run_nondet(_rule, _validator)

        if not isinstance(decided, dict):
            try:
                decided = _parse_llm_json(decided)
            except Exception:
                raise gl.vm.UserError(
                    "[EXPECTED] Consensus returned invalid appeal adjudication JSON"
                )

        new_status = str(decided.get("status", "")).strip().upper()
        if new_status not in ("OVERTURNED", "UPHELD"):
            raise gl.vm.UserError(
                "[EXPECTED] Consensus returned an unknown appeal status"
            )

        rev = json.loads(self.revocations[str(a.get("revocation_id", ""))])
        bond = int(a.get("bond_wei", "0") or 0)

        if new_status == "OVERTURNED":
            payee = str(a.get("appellant", ""))
            settlement = "RETURNED_TO_APPELLANT"
            rev["status"] = "OVERTURNED"
            rev["restoration_status"] = "PENDING_HOST_RESTORE"
            a["restoration_status"] = "PENDING_HOST_RESTORE"
        else:
            payee = str(a.get("watcher", ""))
            settlement = "AWARDED_TO_WATCHER"
            rev["restoration_status"] = "UPHELD"
            a["restoration_status"] = "NONE"

        a["status"] = new_status
        a["adjudication_result"] = str(decided.get("reasoning", ""))

        # Pay the bond out. A transfer that cannot be addressed must not silently
        # vanish, so it is recorded as retained rather than reported as paid.
        paid_to = ""
        if bond > 0 and payee:
            try:
                gl.get_contract_at(Address(payee)).emit_transfer(
                    value=u256(bond), on="finalized"
                )
                paid_to = payee
            except Exception:
                settlement = "RETAINED_PAYOUT_FAILED"
        elif bond > 0:
            settlement = "RETAINED_NO_PAYEE"
        else:
            settlement = "NO_BOND"

        a["bond_settlement"] = settlement
        a["bond_paid_to"] = paid_to

        self.appeals[clean_appeal_id] = json.dumps(a, sort_keys=True)
        self.revocations[str(a.get("revocation_id", ""))] = json.dumps(
            rev, sort_keys=True
        )

        return json.dumps(a, sort_keys=True)

    @gl.public.write
    def confirm_host_restoration(self, appeal_id: str, evm_tx_hash: str) -> str:
        """
        Prove the host-chain restoration landed, then mark the delegation restored.

        The mirror of confirm_host_revocation, and required for the same reason:
        "delegation is restored to active status" is only true once the session
        key works again, which is a fact about the host chain and not about this
        contract's bookkeeping.
        """
        clean_appeal_id = str(appeal_id).strip()
        clean_evm_tx = str(evm_tx_hash).strip().lower()

        if clean_appeal_id not in self.appeals:
            raise gl.vm.UserError("[EXPECTED] Appeal not found")
        if not clean_evm_tx.startswith("0x") or len(clean_evm_tx) != 66:
            raise gl.vm.UserError("[EXPECTED] evm_tx_hash must be a 32 byte hex hash")

        a = json.loads(self.appeals[clean_appeal_id])
        if a.get("status") != "OVERTURNED":
            raise gl.vm.UserError(
                "[EXPECTED] Only an overturned appeal can restore a delegation"
            )
        if a.get("restoration_status") == "RESTORED":
            return json.dumps(a, sort_keys=True)
        if a.get("restoration_status") != "PENDING_HOST_RESTORE":
            raise gl.vm.UserError(
                "[EXPECTED] This appeal is not awaiting host-chain restoration"
            )

        rev_id = str(a.get("revocation_id", ""))
        rev = json.loads(self.revocations[rev_id])

        proof = self._verify_host_event(
            chain_id=str(rev.get("chain_id", "")),
            host_registry=str(rev.get("host_registry", "")),
            host_delegation_id=str(rev.get("host_delegation_id", "")),
            evm_tx_hash=clean_evm_tx,
            event_sig=RESTORED_EVENT_SIG,
            expect_active=True,
        )

        a["restoration_status"] = "RESTORED"
        a["restoration_tx_hash"] = clean_evm_tx
        a["restoration_block_number"] = str(proof.get("block_number", ""))
        rev["restoration_status"] = "RESTORED"
        rev["restoration_tx_hash"] = clean_evm_tx

        self.appeals[clean_appeal_id] = json.dumps(a, sort_keys=True)
        self.revocations[rev_id] = json.dumps(rev, sort_keys=True)

        try:
            gl.get_contract_at(self.registry_address).emit(
                on="finalized"
            ).update_status(str(a.get("delegation_id", "")), "RESTORED")
        except Exception:
            pass

        return json.dumps(a, sort_keys=True)

    # ------------------------------------------------------------------- views

    @gl.public.view
    def get_revocation(self, revocation_id: str) -> str:
        """Return a specific revocation record."""
        clean_id = str(revocation_id).strip()
        if clean_id not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")
        return self.revocations[clean_id]

    @gl.public.view
    def get_revocation_by_verdict(self, verdict_id: str) -> str:
        """Return the revocation a given verdict produced, if any."""
        clean_id = str(verdict_id).strip()
        if clean_id not in self.revoked_verdicts:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")
        rid = self.revoked_verdicts[clean_id]
        if rid not in self.revocations:
            raise gl.vm.UserError("[EXPECTED] Revocation not found")
        return self.revocations[rid]

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

    @gl.public.view
    def get_bond_balance(self) -> str:
        """Native balance this contract is holding, which is escrowed bonds."""
        return str(int(self.balance))
