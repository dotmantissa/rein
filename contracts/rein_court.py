# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json


# Blockscout only, deliberately. Etherscan's V1 proxy endpoint is retired and
# answers HTTP 200 with an error body, which the old status-plus-length check
# accepted as evidence and then broke out of the loop on, so the working
# fallback was never reached and every judge ran on an error page. Etherscan V2
# needs an API key, and a public contract cannot hold one.
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

# Bytes of explorer response read before parsing. This bounds the read, not the
# prompt: only the extracted facts reach the judge. It has to be large enough to
# hold a whole response, because a body truncated mid-JSON fails to parse and is
# indistinguishable from having no evidence at all. A swap with token transfers
# runs to about 25 KB.
MAX_EVIDENCE_BYTES = 65536

# Used verbatim when no explorer returns usable data, so that every validator
# prompts on identical text instead of on its own error page.
NO_EVIDENCE = "NO_VERIFIABLE_TRANSACTION_DATA"

# Used when the explorer did return the transaction, but it was not sent by the
# agent this mandate governs. Nothing about the mandate is at stake, so no
# prompt is spent on it.
NOT_THIS_AGENT = "TRANSACTION_NOT_SENT_BY_THE_REGISTERED_AGENT"

# Words that carry no signal when deciding whether two validators pointed at the
# same mandate clause.
_CLAUSE_STOPWORDS = frozenset(
    (
        "the", "and", "any", "all", "for", "not", "never", "must", "may", "with",
        "that", "this", "from", "into", "onto", "its", "his", "her", "their",
        "you", "your", "are", "was", "were", "has", "have", "had", "but", "nor",
        "than", "then", "them", "they", "will", "shall", "can", "should",
        "would", "agent", "mandate", "clause", "under", "over", "only",
    )
)


def _addr_text(value) -> str:
    """Normalize an address to lowercase hex so two of them can be compared."""
    if value is None:
        return ""
    as_hex = getattr(value, "as_hex", None)
    if isinstance(as_hex, str):
        return as_hex.strip().lower()
    return str(value).strip().lower()


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


def _parse_llm_json(raw) -> dict:
    """
    Parse a JSON object out of an LLM's answer.

    Models routinely wrap JSON in a markdown fence or add a sentence either side
    of it even when asked not to. Treating that as a hard failure throws away a
    usable answer, so recover the object instead: strip any fence, then fall
    back to the outermost brace pair.
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

    Two things make this necessary. A retired endpoint answers 200 with an error
    body, so the response has to be checked for the transaction it was asked
    about rather than merely for being non-empty. And validators fetch
    independently, so feeding them raw JSON means confirmation counts and
    timestamps differ between them and the comparison fails on noise. Keeping
    only fields that are fixed once a transaction is mined gives every validator
    the same evidence to compare.

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


def _clause_tokens(text) -> frozenset:
    """Significant words of a clause, for deciding whether two judges meant the same one."""
    out = set()
    word = []
    for ch in str(text or "").lower():
        if ch.isalnum():
            word.append(ch)
        elif word:
            out.add("".join(word))
            word = []
    if word:
        out.add("".join(word))
    return frozenset(w for w in out if len(w) > 2 and w not in _CLAUSE_STOPWORDS)


def _same_clause(a, b) -> bool:
    """
    Whether two validators identified the same breached clause.

    The README used to promise an exact string match here. Two models quoting
    the same sentence out of a paragraph never produce byte-identical strings,
    so that rule would have rejected every real breach. What matters is that
    they pointed at the same clause, so compare the significant words and
    require at least half of the shorter quote to be shared. An empty quote
    never matches: a breach that names no clause is not a finding.
    """
    ta = _clause_tokens(a)
    tb = _clause_tokens(b)
    if not ta or not tb:
        return False
    if ta <= tb or tb <= ta:
        return True
    return len(ta & tb) * 2 >= min(len(ta), len(tb))


def _verdicts_agree(leader: dict, mine: dict) -> bool:
    """
    The validator comparison rule.

    * The verdict enum must match exactly. Agreement on breach versus not breach
      is the whole point and is never relaxed.
    * On a breach, both judges must have identified the same clause.
    * The severity band may differ by one.

    The asymmetry is in which field is strict, and it is deliberate. A false
    revocation is expensive, so a band dispute should flag an agent for operator
    review rather than throw out a finding over a word.

    Severity is tolerant in both directions, CRITICAL included, and that is a
    correction rather than a relaxation. This rule used to demand exact agreement
    whenever either side said CRITICAL, on the reasoning that an emergency halt
    should be unanimous. Two things were wrong with it. Every band from MED
    upwards triggers the same revocation here, so strictness at CRITICAL bought
    no safety. And a validator that disagrees does not downgrade the band, it
    rejects the whole verdict -- so a HIGH/CRITICAL split discarded a breach the
    judges agreed on, nothing was recorded, nothing was enforced, and the agent
    kept spending. Measured on a real mandate it rejected three runs out of
    three, which made it a standing veto on exactly the breaches it was meant to
    catch.
    """
    if str(leader.get("verdict", "")) != str(mine.get("verdict", "")):
        return False

    if str(leader.get("verdict", "")) != "breach":
        return True

    if not _same_clause(leader.get("breached_clause"), mine.get("breached_clause")):
        return False

    lead_sev = SEVERITY_ORDER.get(str(leader.get("severity", "")), -1)
    mine_sev = SEVERITY_ORDER.get(str(mine.get("severity", "")), -1)
    if lead_sev < 0 or mine_sev < 0:
        return False
    return abs(lead_sev - mine_sev) <= 1


def _llm_json(prompt: str, who: str) -> dict:
    """
    Run a prompt and parse its answer, or fail in a way the network understands.

    This wrapper is the difference between a bad answer and a dead transaction.
    ``_parse_llm_json`` raises whatever ``json`` raises, and a bare Python
    exception inside a nondeterministic block is not recoverable in GenVM: it
    takes the whole VM down. StudioNet reports that as "GenVM crashed 3 times
    with a non-classifiable internal error", with a memory fingerprint and no
    stack trace, and the transaction settles as CANCELED / NO_MAJORITY with zero
    leader receipts and zero validator receipts -- which reads exactly like
    validators disagreeing, and sends the investigation to the wrong place.

    A model returning nothing at all is the common way in. ``exec_prompt`` can
    answer ``None``, and ``str(None)`` is "None", which is not JSON.

    Raising ``[LLM_ERROR]`` instead means validators disagree and the leader is
    rotated, which is the documented handling for a misbehaving model.
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


def _judge_prompt(mandate_text: str, facts: str, description: str, verbose: bool) -> str:
    """
    The judge's prompt. One body, two output shapes.

    The leader and the validators must be asked the same question, or they will
    disagree about the question rather than the answer. They used to be given
    separate prompts, and the severity guidance differed between them: the
    leader's defined the bands while the compact one only listed their names.
    That produced a systematic one-band drift. Measured on a real mandate, the
    leader returned HIGH and the validator CRITICAL on three runs out of three,
    with an identical verdict and an identical clause.

    So the evidence and the rules are identical here, and ``verbose`` changes
    only which fields are asked for. The leader is asked for reasoning and a
    confidence, which are worth having in the audit trail; validators are not,
    because the cost of a prompt is dominated by output length and a validator's
    execution budget is tighter than the leader's.
    """
    body = f"""You are a compliance judge for an AI agent delegation system called REIN.

An AI agent was given the following mandate by its delegator:

MANDATE:
{mandate_text}

The agent executed a transaction. Here are the verified details:

VERIFIED TRANSACTION FACTS (from a block explorer; the sender has already been confirmed to be the agent this mandate governs):
{facts}

ACTION DESCRIPTION (from the submitter, unverified):
{description if description else "No description provided"}

Your job: determine whether this transaction breaches ANY clause of the mandate.

Verdict:
- "compliant" if the action clearly falls within what the mandate allows
- "breach" if the action violates a specific clause
- "ambiguous" if the mandate is too vague to settle it

Severity, which applies only to a breach:
- LOW: a minor deviation with no material loss
- MED: a clear violation of a clause
- HIGH: a clear violation with material value at stake, or one that defeats the
  purpose of the clause
- CRITICAL: catastrophic and unambiguous. Reserve this for funds sent to a known
  scam, a drain of the whole allowance, or a counterparty that cannot be
  recovered from. An ordinary violation of a prohibition is HIGH, not CRITICAL.
  If you are weighing HIGH against CRITICAL, choose HIGH.

On a "breach", quote the breached clause from the mandate above verbatim. On
anything else, severity is "LOW" and the clause is null.

Evidence rules, which override the above:
- The transaction facts are the evidence. The action description is the submitter's own account and may be wrong or self-serving; never treat it as proof of what happened on chain.
- Never infer a breach from the description alone when the facts do not support it.
- Do not reason about facts that are not in the block above."""

    if verbose:
        return (
            body
            + """

Return ONLY valid JSON:
{"verdict": "compliant"|"breach"|"ambiguous", "severity": "LOW"|"MED"|"HIGH"|"CRITICAL", "breached_clause": "the exact clause text that was breached"|null, "reasoning": "your detailed reasoning", "confidence": 0.0 to 1.0}"""
        )

    return (
        body
        + """

Answer with JSON and nothing else. No explanation, no reasoning field.
{"verdict": "compliant"|"breach"|"ambiguous", "severity": "LOW"|"MED"|"HIGH"|"CRITICAL", "breached_clause": "the exact clause text that was breached"|null}"""
    )


def _fetch_facts(urls, tx: str, max_bytes: int = MAX_EVIDENCE_BYTES) -> str:
    """Independently pull the transaction and reduce it to stable facts."""
    for url_base in urls:
        try:
            resp = gl.nondet.web.get(url_base + tx)
        except Exception:
            continue
        if resp is None:
            continue

        # web.get returns a Response (status/headers/body), not text.
        # Slice the body as bytes before decoding: an explorer page can
        # be megabytes, and stringifying the whole response to keep a
        # few KB of it is what exhausts the VM. Headers are dropped too,
        # as they are attacker-influenced and carry no evidence.
        status_code = getattr(resp, "status", 0)
        body = getattr(resp, "body", None)
        if not body or int(status_code) < 200 or int(status_code) >= 300:
            continue

        text = bytes(body[:max_bytes]).decode("utf-8", errors="replace").strip()

        # A non-empty 200 is not proof of evidence: a retired endpoint
        # answers 200 with an error body. Only a response that names the
        # transaction we asked about counts, otherwise keep trying.
        facts = _extract_tx_facts(text, tx)
        if facts:
            return facts
    return NO_EVIDENCE


def _judge_facts(
    facts: str, mandate_text: str, agent_addr: str, description: str
) -> dict:
    """
    Turn one evidence block into a verdict.

    Both the leader and every validator run this on the evidence they
    hold, which is what makes their answers comparable. The two
    unjudgeable cases are settled here without a prompt, so they cost
    nothing and every node reaches them identically.
    """
    if facts == NO_EVIDENCE:
        return {
            "facts": NO_EVIDENCE,
            "verdict": "ambiguous",
            "severity": "LOW",
            "breached_clause": "",
            "reasoning": (
                "No verifiable transaction data was available from the block "
                "explorer, so this action cannot be judged."
            ),
            "confidence": "0.1",
            "attributed": "false",
        }

    sender = ""
    try:
        sender = str(json.loads(facts).get("from", "")).strip().lower()
    except Exception:
        sender = ""

    if sender != agent_addr:
        return {
            "facts": NOT_THIS_AGENT,
            "verdict": "ambiguous",
            "severity": "LOW",
            "breached_clause": "",
            "reasoning": (
                "This transaction was sent by "
                + (sender if sender else "an unreadable address")
                + ", not by the agent registered under this delegation ("
                + agent_addr
                + "). An action another account took cannot breach this "
                "mandate, so it is not judged."
            ),
            "confidence": "0.0",
            "attributed": "false",
        }

    answer = _llm_json(
        _judge_prompt(mandate_text, facts, description, True), "the judge"
    )

    verdict_val = str(answer.get("verdict", "")).strip().lower()
    if verdict_val not in ("compliant", "breach", "ambiguous"):
        raise gl.vm.UserError(
            "[LLM_ERROR] judge returned an unknown verdict: "
            + str(answer.get("verdict"))
        )

    severity_val = str(answer.get("severity", "LOW")).strip().upper()
    if severity_val not in SEVERITY_ORDER:
        severity_val = "LOW"
    if verdict_val != "breach":
        severity_val = "LOW"

    clause = answer.get("breached_clause")
    clause_text = "" if clause is None else str(clause).strip()
    if verdict_val != "breach":
        clause_text = ""

    return {
        "facts": facts,
        "verdict": verdict_val,
        "severity": severity_val,
        "breached_clause": clause_text,
        "reasoning": str(answer.get("reasoning", "")),
        # Carried as text so no float crosses the calldata boundary
        # between the leader and the validators.
        "confidence": str(_normalize_confidence(answer.get("confidence"))),
        "attributed": "true",
    }


def _check_facts(
    facts: str, mandate_text: str, agent_addr: str, description: str
) -> dict:
    """
    The validator's re-decision: the same judgement, asked for in fewer words.

    It is given the submitter's description too, even though the description is
    unverified and the prompt rules forbid relying on it. The point is symmetry:
    if a leader can be swayed by submitter-supplied text, a validator that was
    never shown that text cannot catch it, and the two sides end up disagreeing
    about the question rather than the answer.

    This exists because of what times a validator out. StudioNet gives a
    validator a tighter execution budget than the leader, and the cost of a
    prompt is dominated by how much the model has to *write*, not by how much it
    reads. The leader is asked for detailed reasoning and a confidence, which is
    worth having in the audit trail and is also several hundred output tokens.
    Asking a validator for the same thing timed out three of five of them -- and
    a timed-out validator is worse than a hostile one, because the leader still
    succeeds, the transaction still settles, and the state writes are dropped
    with nothing in the receipt to say why.

    So the validator is asked only for what the comparison rule actually reads:
    the verdict, the band, and the clause. The judgement itself is re-derived
    independently from the same evidence; only the prose is dropped.
    """
    if facts == NO_EVIDENCE:
        return {"verdict": "ambiguous", "severity": "LOW", "breached_clause": ""}

    sender = ""
    try:
        sender = str(json.loads(facts).get("from", "")).strip().lower()
    except Exception:
        sender = ""
    if sender != agent_addr:
        return {"verdict": "ambiguous", "severity": "LOW", "breached_clause": ""}

    answer = _llm_json(
        _judge_prompt(mandate_text, facts, description, False), "a validator"
    )

    verdict_val = str(answer.get("verdict", "")).strip().lower()
    if verdict_val not in ("compliant", "breach", "ambiguous"):
        raise gl.vm.UserError(
            "[LLM_ERROR] validator returned an unknown verdict: "
            + str(answer.get("verdict"))
        )

    severity_val = str(answer.get("severity", "LOW")).strip().upper()
    if severity_val not in SEVERITY_ORDER or verdict_val != "breach":
        severity_val = "LOW" if verdict_val != "breach" else "MED"

    clause = answer.get("breached_clause")
    clause_text = "" if clause is None else str(clause).strip()
    if verdict_val != "breach":
        clause_text = ""

    return {
        "verdict": verdict_val,
        "severity": severity_val,
        "breached_clause": clause_text,
    }



class ReinCourt(gl.Contract):
    """
    ReinCourt: the semantic judge.

    A review names a delegation and a transaction hash, and nothing else. The
    mandate text, the agent the mandate governs and the chain it operates on are
    all read from MandateRegistry, so a review is bound to the delegation that
    was actually registered. A reviewer cannot supply their own mandate text, or
    point the court at a different chain, or attribute somebody else's
    transaction to this agent.

    The court then fetches the transaction from a public block explorer, reduces
    it to stable facts, checks the facts were produced by the registered agent,
    and uses GenLayer consensus to decide whether the action breached a clause.
    Every validator re-derives the attribution from the evidence and re-runs the
    judgement on it, then compares: identical verdict enum, the same breached
    clause, and severity within one adjacent band. See ``_validator`` for what a
    validator re-derives, what it takes from the leader, and why the split falls
    where it does.
    """

    owner: Address
    registry_address: Address
    verdicts: TreeMap[str, str]
    verdict_ids: DynArray[str]
    # "<delegation_id>|<tx_hash>" -> verdict_id. A retried review must not mint
    # a second verdict, and nobody should be able to re-roll the panel on the
    # same transaction until it returns a breach.
    judged: TreeMap[str, str]
    total_verdicts: u256

    # Kept as class attributes so the deployed ABI and existing callers still
    # see them; the nondeterministic closures below read the module-level
    # constants instead, which keeps contract storage out of what gets pickled
    # and shipped to validators.
    EXPLORER_URLS = EXPLORER_URLS
    SEVERITY_ORDER = SEVERITY_ORDER
    MAX_EVIDENCE_BYTES = MAX_EVIDENCE_BYTES
    NO_EVIDENCE = NO_EVIDENCE
    NOT_THIS_AGENT = NOT_THIS_AGENT

    def __init__(self, registry_addr: str):
        self.owner = gl.message.sender_address
        self.registry_address = Address(str(registry_addr).strip())
        self.total_verdicts = u256(0)

    @gl.public.view
    def get_registry_address(self) -> str:
        """The registry this court reads mandates from."""
        return _addr_text(self.registry_address)

    @gl.public.write
    def review_action(
        self,
        delegation_id: str,
        tx_hash: str,
        action_description: str,
    ) -> str:
        """
        Judge one transaction against the mandate it was registered under.

        1. Read the registered mandate, agent and chain from MandateRegistry
        2. Fetch the transaction from a block explorer for that chain
        3. Confirm the registered agent sent it
        4. Judge compliance, and have validators re-derive and compare
        5. Store and return the verdict

        The verdict carries the evidence it was reached on, so the Enforcer and
        the appeal panel can both check the conclusion against the facts rather
        than taking the court's word for it.
        """
        clean_del_id = str(delegation_id).strip()
        clean_tx = str(tx_hash).strip().lower()
        clean_desc = str(action_description).strip() if action_description else ""

        if not clean_del_id:
            raise gl.vm.UserError("[EXPECTED] delegation_id cannot be empty")
        if not clean_tx:
            raise gl.vm.UserError("[EXPECTED] tx_hash cannot be empty")
        if not clean_tx.startswith("0x") or len(clean_tx) != 66:
            raise gl.vm.UserError("[EXPECTED] tx_hash must be a 32 byte hex hash")
        try:
            int(clean_tx[2:], 16)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] tx_hash must be a 32 byte hex hash")

        # A retry of a broadcast that already landed must return the verdict it
        # produced, not a second one.
        index_key = clean_del_id + "|" + clean_tx
        if index_key in self.judged:
            existing = self.judged[index_key]
            if existing in self.verdicts:
                return self.verdicts[existing]

        # ---- bind the review to the registered mandate, agent and chain ----
        registry = gl.get_contract_at(self.registry_address)
        try:
            mandate_raw = registry.view().get_mandate(clean_del_id)
        except Exception:
            raise gl.vm.UserError(
                "[EXPECTED] Delegation " + clean_del_id + " is not registered"
            )
        try:
            mandate = json.loads(str(mandate_raw))
        except Exception:
            raise gl.vm.UserError("[EXPECTED] Registry returned an unreadable mandate")
        if not isinstance(mandate, dict):
            raise gl.vm.UserError("[EXPECTED] Registry returned an unreadable mandate")

        clean_mandate = str(mandate.get("mandate_text", "")).strip()
        agent = _addr_text(mandate.get("agent_address"))
        chain = str(mandate.get("chain_id", "")).strip()
        mandate_hash = str(mandate.get("mandate_hash", ""))
        status = str(mandate.get("status", ""))

        if not clean_mandate:
            raise gl.vm.UserError(
                "[EXPECTED] Registered mandate has no text to judge against"
            )
        if not agent:
            raise gl.vm.UserError("[EXPECTED] Registered mandate names no agent")
        if status == "REVOKED":
            raise gl.vm.UserError(
                "[EXPECTED] Delegation "
                + clean_del_id
                + " is already revoked; its authority is gone and there is nothing to enforce"
            )

        urls = EXPLORER_URLS.get(chain)
        if not urls:
            raise gl.vm.UserError(
                "[EXPECTED] No block explorer configured for chain " + chain
            )

        # Bound once here and handed to the module-level judge helpers below.
        # Those live at module scope on purpose: a closure that reaches two
        # levels deep is invisible to the GenVM linter's reachability check, and
        # a nondeterministic call it cannot see is one nobody is checking.
        tx = clean_tx
        mandate_text = clean_mandate
        description = clean_desc
        agent_addr = agent

        def _leader() -> dict:
            return _judge_facts(
                _fetch_facts(urls, tx), mandate_text, agent_addr, description
            )

        def _validator(leaders_res) -> bool:
            """
            Re-run the judgement on the leader's evidence and compare it.

            What a validator can afford is the constraint here. StudioNet gives
            a validator a tighter execution budget than the leader, and the
            costs are measurable: two prompts (the old `prompt_comparative`)
            timed out every validator, and one fetch plus one prompt timed out
            three of five -- which is worse than useless, because the leader
            still succeeds, the transaction still settles as FINALIZED, and the
            state writes are dropped with nothing in the receipt to say why.
            One prompt is the budget that holds.

            So the evidence is not re-fetched; it is checked. Three things are
            re-derived from the leader's own facts for free, and they are the
            ones that decide what is being judged rather than how:

            * the facts must parse,
            * they must describe the transaction this review named, and
            * the sender must be the agent this mandate governs.

            The judgement is then re-derived from that same evidence by
            ``_check_facts``, which asks for the decision without the prose, and
            the two answers are compared on the fields the rule reads.

            What this cannot catch is a leader that reports no verifiable
            evidence when some exists. That direction fails safe: the verdict
            becomes "ambiguous" at confidence 0.1, which the Enforcer refuses to
            revoke on, so the worst case is a review that has to be resubmitted.
            The dangerous direction -- inventing a breach, or pinning one
            agent's transaction on another -- is the one that is checked.
            """
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            leader = leaders_res.calldata
            if not isinstance(leader, dict):
                return False

            basis = str(leader.get("facts", ""))

            if basis not in (NO_EVIDENCE, NOT_THIS_AGENT):
                try:
                    parsed = json.loads(basis)
                except Exception:
                    return False
                if not isinstance(parsed, dict):
                    return False
                if str(parsed.get("hash", "")).strip().lower() != tx:
                    return False
                if str(parsed.get("from", "")).strip().lower() != agent_addr:
                    return False

            return _verdicts_agree(
                leader, _check_facts(basis, mandate_text, agent_addr, description)
            )

        decided = gl.vm.run_nondet(_leader, _validator)

        if not isinstance(decided, dict):
            try:
                decided = _parse_llm_json(decided)
            except Exception:
                raise gl.vm.UserError("[EXPECTED] Consensus returned invalid verdict JSON")

        verdict_val = str(decided.get("verdict", ""))
        if verdict_val not in ("compliant", "breach", "ambiguous"):
            raise gl.vm.UserError("[EXPECTED] Invalid verdict value")

        severity_val = str(decided.get("severity", "LOW"))
        if severity_val not in SEVERITY_ORDER:
            severity_val = "LOW"

        clause = decided.get("breached_clause")
        clause_text = None if not clause else str(clause)

        nonce = int(self.total_verdicts)
        verdict_id = f"vrd_{clean_del_id}_{nonce}"

        verdict_record = {
            "verdict_id": verdict_id,
            "delegation_id": clean_del_id,
            "tx_hash": clean_tx,
            "chain_id": chain,
            # Bound at judgement time. The Enforcer checks these against the
            # registry before it will act on this verdict, so a mandate that was
            # edited afterwards, or a verdict about a different agent, cannot be
            # used to revoke.
            "agent_address": agent,
            "mandate_hash": mandate_hash,
            "verdict": verdict_val,
            "severity": severity_val,
            "breached_clause": clause_text,
            "reasoning": str(decided.get("reasoning", "")),
            "confidence": _normalize_confidence(decided.get("confidence")),
            # The evidence the verdict was reached on, kept so the appeal panel
            # re-reads the verified action instead of a retelling of it.
            "facts": str(decided.get("facts", NO_EVIDENCE)),
            "attributed": str(decided.get("attributed", "false")) == "true",
            "submitted_by": _addr_text(gl.message.sender_address),
        }

        self.verdicts[verdict_id] = json.dumps(verdict_record, sort_keys=True)
        self.verdict_ids.append(verdict_id)
        self.judged[index_key] = verdict_id
        self.total_verdicts = u256(nonce + 1)

        # Keep the registry's reviewed-action tally honest. It has always been a
        # field in the mandate record and nothing ever incremented it.
        try:
            registry.emit(on="finalized").increment_action_count(clean_del_id)
        except Exception:
            pass

        return json.dumps(verdict_record, sort_keys=True)

    @gl.public.view
    def get_verdict(self, verdict_id: str) -> str:
        """Return a specific verdict by its ID."""
        clean_id = str(verdict_id).strip()
        if clean_id not in self.verdicts:
            raise gl.vm.UserError("[EXPECTED] Verdict not found")
        return self.verdicts[clean_id]

    @gl.public.view
    def get_verdict_for_action(self, delegation_id: str, tx_hash: str) -> str:
        """Return the verdict already issued for a delegation and transaction."""
        key = str(delegation_id).strip() + "|" + str(tx_hash).strip().lower()
        if key not in self.judged:
            raise gl.vm.UserError("[EXPECTED] Verdict not found")
        vid = self.judged[key]
        if vid not in self.verdicts:
            raise gl.vm.UserError("[EXPECTED] Verdict not found")
        return self.verdicts[vid]

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
