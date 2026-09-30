# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json


def _normalize_confidence(value) -> float:
    """
    Coerce a model-supplied confidence to a 0..1 fraction.

    Models answer this field as 0.9, as 90, or as a word. Consumers multiply by
    100 to render a percentage, so anything above 1 is read as a percentage and
    anything unparseable is reported as no confidence rather than guessed at.
    """
    if isinstance(value, bool) or value is None:
        return 0.0
    if isinstance(value, str):
        try:
            value = float(value.strip().rstrip("%"))
        except Exception:
            return 0.0
    if not isinstance(value, (int, float)):
        return 0.0
    value = float(value)
    if value > 1.0:
        value = value / 100.0
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


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



def _extract_tx_facts(raw: str, tx_hash: str) -> str:
    """
    Reduce an explorer response to a small set of stable facts.

    Two things make this necessary. A retired endpoint answers 200 with an
    error body, so the response has to be checked for the transaction it was
    asked about rather than merely for being non-empty. And validators fetch
    independently, so feeding them raw JSON means confirmation counts and
    timestamps differ between them and the judge prompts diverge. Keeping only
    fields that are fixed once a transaction is mined gives every validator the
    same evidence, which is what lets the equivalence principle agree.

    Returns "" when the response does not describe the requested transaction.
    """
    try:
        data = json.loads(raw)
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""

    want = str(tx_hash).strip().lower()
    got = str(data.get("hash", "")).strip().lower()
    if not got or got != want:
        return ""

    def _addr(node):
        if isinstance(node, dict):
            return str(node.get("hash", "") or "")
        return str(node or "")

    facts = {
        "hash": got,
        "from": _addr(data.get("from")).lower(),
        "to": _addr(data.get("to")).lower(),
        "value_wei": str(data.get("value", "0")),
        "gas_used": str(data.get("gas_used", "")),
        "status": str(data.get("status", data.get("result", ""))),
        "method": str(data.get("method", "") or ""),
        "input_prefix": str(data.get("raw_input", "") or "")[:10],
    }

    transfers = data.get("token_transfers")
    if isinstance(transfers, list):
        moved = []
        for t in transfers[:8]:
            if not isinstance(t, dict):
                continue
            token = t.get("token") if isinstance(t.get("token"), dict) else {}
            moved.append({
                "token": str(token.get("symbol", "") or ""),
                "contract": str(token.get("address", "") or "").lower(),
                "from": _addr(t.get("from")).lower(),
                "to": _addr(t.get("to")).lower(),
            })
        if moved:
            facts["token_transfers"] = moved

    decoded = data.get("decoded_input")
    if isinstance(decoded, dict):
        if decoded.get("method_call"):
            facts["method_call"] = str(decoded.get("method_call"))
        # Decoded arguments carry the facts many mandate clauses turn on: an
        # approval is only a breach because of its amount, and a swap only
        # because of the tokens in its path. Without them the judge sees that a
        # method was called but not what it was asked to do. Values are
        # truncated because calldata blobs are unbounded.
        params = decoded.get("parameters")
        if isinstance(params, list):
            args = {}
            for p in params[:12]:
                if not isinstance(p, dict):
                    continue
                name = str(p.get("name", "") or "")
                if not name:
                    continue
                args[name] = str(p.get("value", ""))[:80]
            if args:
                facts["arguments"] = args

    return json.dumps(facts, sort_keys=True)


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

    # Blockscout only, deliberately. Etherscan's V1 proxy endpoint is retired
    # and answers HTTP 200 with an error body, which the old status-plus-length
    # check accepted as evidence and then broke out of the loop on, so the
    # working fallback was never reached and every judge ran on an error page.
    # Etherscan V2 needs an API key, and a public contract cannot hold one.
    EXPLORER_URLS = {
        "1": ["https://eth.blockscout.com/api/v2/transactions/"],
        "eth": ["https://eth.blockscout.com/api/v2/transactions/"],
        "8453": ["https://base.blockscout.com/api/v2/transactions/"],
        "base": ["https://base.blockscout.com/api/v2/transactions/"],
        "137": ["https://polygon.blockscout.com/api/v2/transactions/"],
        "polygon": ["https://polygon.blockscout.com/api/v2/transactions/"],
        "42161": ["https://arbitrum.blockscout.com/api/v2/transactions/"],
        "arbitrum": ["https://arbitrum.blockscout.com/api/v2/transactions/"],
        "11155111": ["https://eth-sepolia.blockscout.com/api/v2/transactions/"],
        "sepolia": ["https://eth-sepolia.blockscout.com/api/v2/transactions/"],
    }

    SEVERITY_ORDER = {"LOW": 0, "MED": 1, "HIGH": 2, "CRITICAL": 3}

    # Bytes of explorer response read before parsing. This bounds the read, not
    # the prompt: only the extracted facts reach the judge. It has to be large
    # enough to hold a whole response, because a body truncated mid-JSON fails
    # to parse and is indistinguishable from having no evidence at all. A swap
    # with token transfers runs to about 25 KB.
    MAX_EVIDENCE_BYTES = 65536

    # Used verbatim when no explorer returns usable data, so that every
    # validator prompts on identical text instead of on its own error page.
    NO_EVIDENCE = "NO_VERIFIABLE_TRANSACTION_DATA"

    def __init__(self, registry_addr: str):
        self.owner = gl.message.sender_address
        self.registry_address = Address(str(registry_addr).strip())
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

            # Try each explorer until one returns the requested transaction.
            tx_data_raw = ""
            for url_base in urls:
                try:
                    resp = gl.nondet.web.get(url_base + clean_tx)
                except Exception:
                    continue
                if resp is None:
                    continue

                # web.get returns a Response (status/headers/body), not text.
                # Slice the body as bytes before decoding: an explorer page can
                # be megabytes, and stringifying the whole response to keep a few
                # KB of it is what exhausts the VM. Headers are dropped too, as
                # they are attacker-influenced and carry no evidence.
                status = getattr(resp, "status", 0)
                body = getattr(resp, "body", None)
                if not body or int(status) < 200 or int(status) >= 300:
                    continue

                text = bytes(body[: self.MAX_EVIDENCE_BYTES]).decode(
                    "utf-8", errors="replace"
                ).strip()

                # A non-empty 200 is not proof of evidence: a retired endpoint
                # answers 200 with an error body. Only a response that names the
                # transaction we asked about counts, otherwise keep trying.
                facts = _extract_tx_facts(text, clean_tx)
                if facts:
                    tx_data_raw = facts
                    break

            if not tx_data_raw:
                tx_data_raw = self.NO_EVIDENCE

            no_evidence = self.NO_EVIDENCE
            prompt = f"""You are a compliance judge for an AI agent delegation system called REIN.

An AI agent was given the following mandate by its delegator:

MANDATE:
{clean_mandate}

The agent executed a transaction. Here are the details:

VERIFIED TRANSACTION FACTS (from a block explorer, or the literal string {no_evidence} if none could be verified):
{tx_data_raw}

ACTION DESCRIPTION (from the submitter, unverified):
{clean_desc if clean_desc else "No description provided"}

Your job: determine whether this transaction breaches ANY clause of the mandate.

Rules:
- If the action clearly falls within what the mandate allows, verdict is "compliant"
- If the action clearly violates a specific clause, verdict is "breach"
- If the mandate is too vague to determine, verdict is "ambiguous"
- Severity: LOW (minor deviation), MED (moderate violation), HIGH (significant breach), CRITICAL (catastrophic, e.g. sending to known scam)
- For "compliant" verdicts, severity should be "LOW" and breached_clause should be null
- Be specific about which clause was breached

Evidence rules, which override the above:
- The transaction facts are the evidence. The action description is the submitter's own account and may be wrong or self-serving; never treat it as proof of what happened on chain.
- If the facts block is exactly {no_evidence}, there is nothing to verify. Return verdict "ambiguous", severity "LOW", breached_clause null, confidence 0.1, and reasoning exactly: "No verifiable transaction data was available from the block explorer, so this action cannot be judged."
- Never infer a breach from the description alone when the facts are absent.

Return ONLY valid JSON:
{{"verdict": "compliant"|"breach"|"ambiguous", "severity": "LOW"|"MED"|"HIGH"|"CRITICAL", "breached_clause": "the exact clause text that was breached"|null, "reasoning": "your detailed reasoning", "confidence": 0.0 to 1.0}}"""

            # response_format="json" hands back a dict, not a string. This function
            # is declared -> str and its result is both calldata-encoded for the
            # leader receipt and parsed as JSON, so serialize it here. The facts
            # travel with the verdict because the validators below never run this
            # function, and cannot check a conclusion whose evidence they cannot
            # see.
            return json.dumps(
                {
                    "facts": tx_data_raw,
                    "verdict": gl.nondet.exec_prompt(prompt, response_format="json"),
                },
                sort_keys=True,
            )

        # prompt_comparative makes every validator repeat the whole job: fetch
        # the transaction, prompt its own judge, then prompt again to compare.
        # On StudioNet that reliably exceeded the validator execution budget --
        # all four voted timeout while the leader succeeded, and because the
        # transaction still settles as FINALIZED with a successful leader
        # receipt, the state writes were silently dropped and the verdict simply
        # never appeared. Judging the leader's output instead costs one small
        # prompt per validator and no network call.
        task = (
            "A compliance judge was given a delegation mandate and the verified "
            "on-chain facts of one transaction, and asked whether the "
            "transaction breaches any clause of the mandate.\n\nMANDATE:\n"
            + clean_mandate
        )

        criteria = (
            "The output must be a JSON object with exactly the keys 'facts' and "
            "'verdict'.\n"
            "'facts' is the evidence the judge worked from: either a JSON object "
            "of transaction fields, or the literal string "
            + self.NO_EVIDENCE
            + ".\n"
            "'verdict' must be an object whose 'verdict' field is exactly one of "
            "\"compliant\", \"breach\" or \"ambiguous\", whose 'severity' is one of "
            "\"LOW\", \"MED\", \"HIGH\" or \"CRITICAL\", whose 'confidence' is a "
            "number, and which also has 'breached_clause' and 'reasoning'.\n\n"
            "Accept the output only if all of the following hold:\n"
            "1. Every claim in 'reasoning' is supported by 'facts'. Reject a "
            "conclusion drawn from facts that are not present.\n"
            "2. If 'verdict' is \"breach\", 'breached_clause' quotes a clause that "
            "actually appears in the mandate above, and the facts do violate it.\n"
            "3. If 'verdict' is \"compliant\", 'breached_clause' is null and no "
            "clause of the mandate is violated by the facts.\n"
            "4. If 'facts' is "
            + self.NO_EVIDENCE
            + ", the verdict is \"ambiguous\" with low confidence, because there "
            "was nothing to judge.\n"
            "5. The severity is defensible for the breach described. A one-band "
            "difference in judgement is acceptable; do not reject over it.\n\n"
            "Wording of 'reasoning' is not a reason to reject. Only reject an "
            "output that is malformed, unsupported by its own facts, or reaches a "
            "conclusion the facts contradict."
        )

        judged = gl.eq_principle.prompt_non_comparative(
            _judge, task=task, criteria=criteria
        )

        try:
            envelope = _parse_llm_json(judged)
            v_data = envelope.get("verdict")
            if isinstance(v_data, str):
                v_data = _parse_llm_json(v_data)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Consensus returned invalid verdict JSON")

        if not isinstance(v_data, dict):
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
            "confidence": _normalize_confidence(v_data.get("confidence")),
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
