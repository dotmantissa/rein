"""
ReinCourt: what a review is bound to, and what validators compare.

The reviewer's note starts with "bind each review to the registered mandate,
agent, and chain". It did not used to be. review_action took mandate_text,
chain_id and a description as arguments, and the backend passed whatever its own
database held, so the court judged an agent against text nobody had registered
and attributed any transaction hash on any chain to it. Those are the first
group of tests here.

The second group covers the comparison rule the README publishes: the verdict
enum must match exactly, the same clause must be identified, and severity may
differ by one band except at CRITICAL.
"""

import json
import pytest

from contracts.rein_court import (
    NOT_THIS_AGENT,
    NO_EVIDENCE,
    _same_clause,
    _verdicts_agree,
)
from tests.builders import (
    AGENT,
    CHAIN,
    MANDATE,
    RELAYER,
    STRANGER,
    TX,
    blockscout_body,
    deploy_stack,
    drifting_prompt,
    explorer_handler,
    register,
    run_review,
    verdict_prompt,
)
from tests.conftest import keccak_hex, world


# ------------------------------------------------------- binding to the record


def test_the_judge_is_given_the_registered_mandate_not_a_caller_supplied_one():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    # A caller who wants a breach can no longer supply a mandate that produces
    # one: the third argument is a description, and descriptions are labelled
    # unverified in the prompt.
    run_review(w, court, did, description="Never do anything, ever")

    prompt = w.prompts[0]
    assert MANDATE in prompt
    assert "Never do anything, ever" in prompt
    assert "unverified" in prompt.lower()


def test_a_review_of_an_unregistered_delegation_is_refused():
    w = world()
    _, court, _ = deploy_stack(w)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    with pytest.raises(ValueError, match="not registered"):
        run_review(w, court, "del_made_up_0")


def test_the_chain_comes_from_the_registry():
    """
    chain_id used to be an argument, so a reviewer could point the court at a
    different chain's explorer than the one the delegation operates on. It is
    now read from the record, and the Sepolia mandate fetches from Sepolia.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry, chain=CHAIN)

    seen = []

    def handler(method, url, body):
        seen.append(url)
        return explorer_handler()(method, url, body)

    w.http = handler
    w.prompt = verdict_prompt()
    run_review(w, court, did)

    assert len(seen) >= 1
    assert all("eth-sepolia.blockscout.com" in u for u in seen)
    assert all(u.endswith(TX) for u in seen)


def test_a_transaction_another_account_sent_is_not_judged():
    """
    Binding to the agent. Without this, anyone could point the court at any
    damning transaction on the chain and have it attributed to someone else's
    agent. No prompt is spent on it either: the sender is a deterministic read.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler(blockscout_body(sender=STRANGER))
    w.prompt = verdict_prompt()

    v = run_review(w, court, did)

    assert v["verdict"] == "ambiguous"
    assert v["attributed"] is False
    assert v["facts"] == NOT_THIS_AGENT
    assert STRANGER.lower() in v["reasoning"]
    assert w.prompts == []


def test_the_agents_own_transaction_is_judged():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler(blockscout_body(sender=AGENT))
    w.prompt = verdict_prompt()

    v = run_review(w, court, did)

    assert v["verdict"] == "breach"
    assert v["attributed"] is True
    assert v["agent_address"] == AGENT.lower()
    assert len(w.prompts) >= 1


def test_the_verdict_records_what_it_was_bound_to():
    """
    agent_address and mandate_hash travel with the verdict so the enforcer can
    refuse to act on a ruling about a delegation that has since changed.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    v = run_review(w, court, did)

    assert v["mandate_hash"] == keccak_hex(MANDATE)
    assert v["agent_address"] == AGENT.lower()
    assert v["delegation_id"] == did
    assert v["chain_id"] == CHAIN
    assert v["tx_hash"] == TX
    assert v["submitted_by"] == RELAYER.lower()
    # The evidence itself, so an appeal can re-read the action.
    assert json.loads(v["facts"])["hash"] == TX


def test_reviewing_a_revoked_delegation_is_refused():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    from tests.builders import DELEGATOR

    w.call(registry, "update_status", did, "REVOKED", sender=DELEGATOR)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    with pytest.raises(ValueError, match="already revoked"):
        run_review(w, court, did)


def test_a_repeated_review_returns_the_same_verdict():
    """
    The relayer broadcasts and polls, so a retry after a timeout is normal. Two
    verdicts for one transaction would also let a watcher re-roll the panel
    until it returned a breach.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    first = run_review(w, court, did)
    prompts_after_first = len(w.prompts)
    second = run_review(w, court, did)

    assert first["verdict_id"] == second["verdict_id"]
    assert w.call(court, "get_verdict_count") == 1
    assert len(w.prompts) == prompts_after_first  # no second panel was convened


def test_the_court_counts_the_review_against_the_mandate():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    run_review(w, court, did)

    assert json.loads(w.call(registry, "get_mandate", did))["action_count"] == 1
    assert any(e["method"] == "increment_action_count" for e in w.emits)


@pytest.mark.parametrize("bad", ["", "0x1234", "not a hash", "0x" + "zz" * 32])
def test_malformed_transaction_hashes_are_refused(bad):
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    with pytest.raises(ValueError, match="tx_hash"):
        run_review(w, court, did, tx=bad)


def test_no_evidence_yields_an_unjudgeable_verdict_without_a_prompt():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler("{}", status=200)
    w.prompt = verdict_prompt()

    v = run_review(w, court, did)

    assert v["verdict"] == "ambiguous"
    assert v["facts"] == NO_EVIDENCE
    assert v["confidence"] == pytest.approx(0.1)
    assert w.prompts == []


# ------------------------------------------------------- the comparison rule


def test_validators_agreeing_lets_the_verdict_stand():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    run_review(w, court, did)

    assert w.validator_votes == [True]


def test_disagreement_on_breach_versus_compliant_blocks_the_verdict():
    """
    Agreement on breach versus not breach is the one thing never relaxed. The
    old implementation asked a model whether the leader's prose looked
    supported, which could ratify a conclusion a second judge would not reach.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = drifting_prompt(
        [
            {
                "verdict": "breach",
                "severity": "HIGH",
                "breached_clause": "Never move more than 1 ETH in a single transaction",
                "reasoning": "moved 37 ETH",
                "confidence": 0.9,
            },
            {
                "verdict": "compliant",
                "severity": "LOW",
                "breached_clause": None,
                "reasoning": "within scope",
                "confidence": 0.9,
            },
        ]
    )

    with pytest.raises(ValueError, match="did not agree"):
        run_review(w, court, did)
    assert w.call(court, "get_verdict_count") == 0


def test_a_one_band_severity_difference_is_tolerated():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    clause = "Never move more than 1 ETH in a single transaction"
    w.prompt = drifting_prompt(
        [
            {"verdict": "breach", "severity": "MED", "breached_clause": clause,
             "reasoning": "over the limit", "confidence": 0.8},
            {"verdict": "breach", "severity": "HIGH", "breached_clause": clause,
             "reasoning": "well over the limit", "confidence": 0.9},
        ]
    )

    v = run_review(w, court, did)
    assert v["severity"] == "MED"  # the leader's band is what is recorded
    assert w.validator_votes == [True]


def test_a_two_band_severity_difference_is_not():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    clause = "Never move more than 1 ETH in a single transaction"
    w.prompt = drifting_prompt(
        [
            {"verdict": "breach", "severity": "LOW", "breached_clause": clause,
             "reasoning": "slightly over", "confidence": 0.8},
            {"verdict": "breach", "severity": "HIGH", "breached_clause": clause,
             "reasoning": "far over", "confidence": 0.9},
        ]
    )

    with pytest.raises(ValueError, match="did not agree"):
        run_review(w, court, did)


def test_a_high_critical_split_still_records_the_breach():
    """
    The rule this replaced required exact agreement whenever either side said
    CRITICAL, so that an emergency halt would be unanimous. It was measured
    rejecting three runs out of three on a real mandate -- the leader said HIGH,
    the validator CRITICAL, with an identical verdict and clause -- and a
    validator that disagrees does not downgrade the band, it discards the whole
    verdict. Nothing was recorded, nothing was enforced, and the agent kept
    spending. Every band from MED up revokes identically here, so the strictness
    bought no safety and cost the finding.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    clause = "Never pay for advertising of any kind"
    w.prompt = drifting_prompt(
        [
            {"verdict": "breach", "severity": "HIGH", "breached_clause": clause,
             "reasoning": "sent to an ad network", "confidence": 0.95},
            {"verdict": "breach", "severity": "CRITICAL", "breached_clause": clause,
             "reasoning": "sent to an ad network", "confidence": 0.99},
        ]
    )

    v = run_review(w, court, did)
    assert v["verdict"] == "breach"
    assert v["severity"] == "HIGH"  # the leader's band is what is recorded
    assert w.validator_votes == [True]


def test_a_med_critical_split_is_still_too_far_apart():
    """
    Tolerance is one band, not unlimited. Two bands apart is a real
    disagreement about how serious the breach was, whichever bands they are.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    clause = "Never pay for advertising of any kind"
    w.prompt = drifting_prompt(
        [
            {"verdict": "breach", "severity": "MED", "breached_clause": clause,
             "reasoning": "small ad spend", "confidence": 0.7},
            {"verdict": "breach", "severity": "CRITICAL", "breached_clause": clause,
             "reasoning": "catastrophic", "confidence": 0.99},
        ]
    )

    with pytest.raises(ValueError, match="did not agree"):
        run_review(w, court, did)


def test_a_different_clause_blocks_the_verdict():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = drifting_prompt(
        [
            {"verdict": "breach", "severity": "HIGH",
             "breached_clause": "Never move more than 1 ETH in a single transaction",
             "reasoning": "amount", "confidence": 0.9},
            {"verdict": "breach", "severity": "HIGH",
             "breached_clause": "Never pay for advertising of any kind",
             "reasoning": "recipient", "confidence": 0.9},
        ]
    )

    with pytest.raises(ValueError, match="did not agree"):
        run_review(w, court, did)


def test_clause_matching_tolerates_wording_but_not_substitution():
    """
    The README used to promise an exact string match on the clause. Two models
    quoting the same sentence never produce identical strings, so that rule
    would have rejected every real breach while reading as if it were strict.
    """
    assert _same_clause(
        "Never move more than 1 ETH in a single transaction",
        "never move more than 1 ETH in a single transaction.",
    )
    assert _same_clause(
        "never move more than 1 ETH in a single transaction",
        "move more than 1 ETH in a single transaction",
    )
    assert not _same_clause(
        "Never move more than 1 ETH in a single transaction",
        "Never pay for advertising of any kind",
    )
    # A breach that names no clause is not a finding.
    assert not _same_clause("", "Never pay for advertising")
    assert not _same_clause(None, None)


def test_agreement_rule_in_isolation():
    breach = {"verdict": "breach", "severity": "HIGH", "breached_clause": "no ads please"}
    assert _verdicts_agree(breach, dict(breach))
    assert _verdicts_agree(breach, {**breach, "severity": "CRITICAL"})
    assert _verdicts_agree(breach, {**breach, "severity": "MED"})
    assert not _verdicts_agree(breach, {**breach, "severity": "LOW"})
    assert _verdicts_agree({"verdict": "compliant"}, {"verdict": "compliant"})
    assert _verdicts_agree({"verdict": "ambiguous"}, {"verdict": "ambiguous"})
    assert not _verdicts_agree({"verdict": "compliant"}, {"verdict": "ambiguous"})
    # An unknown severity band cannot be compared, so it is not agreement.
    assert not _verdicts_agree(breach, {**breach, "severity": "SEVERE"})


def test_a_validator_rejects_evidence_for_a_different_transaction():
    """
    A leader cannot change which transaction is under review. The facts must
    name the hash the review named, and every validator re-derives that from
    the leader's own evidence for free.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    # The explorer answers with a different transaction than the one requested.
    other = "0x" + "77" * 32
    w.http = explorer_handler(blockscout_body(tx=other, sender=AGENT))
    w.prompt = verdict_prompt()

    # _extract_tx_facts refuses it outright, so the judge sees no evidence
    # rather than somebody else's transaction.
    v = run_review(w, court, did)
    assert v["facts"] == NO_EVIDENCE
    assert v["verdict"] == "ambiguous"


def test_a_fabricated_breach_is_caught_but_a_buried_one_fails_safe():
    """
    The asymmetry the validator actually implements.

    Inventing a breach is checked: the validator re-decides on the same evidence
    and the two answers have to agree. Reporting no evidence when some exists is
    not checkable within a validator's budget, but it fails safe -- it yields an
    ambiguous verdict at low confidence, which cannot revoke.
    """
    from contracts.rein_court import _fetch_facts, _judge_facts

    w = world()
    registry, court, _ = deploy_stack(w)
    register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt(verdict="compliant", clause=None, severity="LOW")

    urls = ["https://eth-sepolia.blockscout.com/api/v2/transactions/"]
    real = _fetch_facts(urls, TX)
    assert real != NO_EVIDENCE

    honest = _judge_facts(real, MANDATE, AGENT.lower(), "")
    assert honest["verdict"] == "compliant"

    invented = {
        "facts": real,
        "verdict": "breach",
        "severity": "CRITICAL",
        "breached_clause": "Never pay for advertising of any kind",
        "reasoning": "made up",
        "confidence": "0.99",
        "attributed": "true",
    }
    assert not _verdicts_agree(invented, honest)

    buried = _judge_facts(NO_EVIDENCE, MANDATE, AGENT.lower(), "")
    assert buried["verdict"] == "ambiguous"
    assert float(buried["confidence"]) <= 0.1
    # Low-confidence ambiguity is exactly what the Enforcer refuses to act on,
    # so the unverifiable direction cannot end a delegation.
    assert buried["severity"] == "LOW"


def test_the_validator_is_asked_for_a_decision_not_an_essay():
    """
    Regression guard for the failure that is hardest to see.

    A StudioNet validator has a tighter execution budget than the leader, and the
    cost of a prompt is dominated by output length. Asking validators for the
    leader's full answer -- detailed reasoning and a confidence -- timed out
    three of five of them. The leader then still succeeds, the transaction still
    settles as FINALIZED, and the state writes are dropped with nothing in the
    receipt to say why, so the verdict simply never appears.

    The validator must therefore be asked only for what the comparison rule
    reads, and must not be asked to write prose.
    """
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt()

    run_review(w, court, did, description="Agent moved funds")

    assert len(w.prompts) == 2, "expected one leader prompt and one validator prompt"
    leader_prompt, validator_prompt = w.prompts

    # The leader is asked for the audit trail.
    assert "detailed reasoning" in leader_prompt
    assert "confidence" in leader_prompt

    # The validator is told not to produce either.
    assert "no reasoning field" in validator_prompt
    assert "No explanation" in validator_prompt
    assert '"reasoning"' not in validator_prompt
    assert '"confidence"' not in validator_prompt
    assert len(validator_prompt) < len(leader_prompt)

    # Both are asked the same question on the same evidence, so the two answers
    # are comparable rather than merely both well-formed. The severity guidance
    # in particular has to be identical: when it was not, the two sides drifted
    # a full band apart every single time.
    for shared in (
        MANDATE,
        "37407860000000000000",
        "If you are weighing HIGH against CRITICAL, choose HIGH.",
        "Agent moved funds",  # the submitter's description, shown to both
    ):
        assert shared in leader_prompt
        assert shared in validator_prompt


def test_the_validator_re_derives_attribution_for_free():
    """
    A leader cannot pin one account's transaction on another agent. The sender
    check is a deterministic read of the evidence, so the validator repeats it
    without spending a prompt on it.
    """
    from contracts.rein_court import _check_facts

    facts_other = json.dumps(
        {"hash": TX, "from": STRANGER.lower(), "to": "0xb", "value_wei": "1"},
        sort_keys=True,
    )
    out = _check_facts(facts_other, MANDATE, AGENT.lower(), "")
    assert out["verdict"] == "ambiguous"
    assert out["breached_clause"] == ""


@pytest.mark.parametrize("bad", [None, "", "not json at all", "```\nnope\n```"])
def test_an_unparseable_model_answer_is_classified_not_a_crash(bad):
    """
    The defect that cost the most time to find, because the symptom pointed
    somewhere else entirely.

    `_parse_llm_json` raises whatever `json` raises, and a bare Python exception
    inside a nondeterministic block is unrecoverable in GenVM: it takes the VM
    down. StudioNet reported that as "GenVM crashed 3 times with a
    non-classifiable internal error" and settled the transaction as CANCELED
    with result NO_MAJORITY and *zero* leader and validator receipts -- which
    reads exactly like validators disagreeing, and sent the investigation after
    the comparison rule instead of the parse.

    A model answering nothing is the common way in: exec_prompt can return None,
    and str(None) is "None", which is not JSON.

    The requirement is that a bad answer raises [LLM_ERROR], which makes
    validators disagree and rotates the leader, and never escapes as a bare
    exception.
    """
    from contracts.rein_court import _llm_json

    w = world()
    w.prompt = lambda prompt: bad

    with pytest.raises(ValueError, match=r"\[LLM_ERROR\]") as caught:
        _llm_json("does not matter", "the judge")

    # Specifically a classified UserError, not a JSONDecodeError that happens to
    # subclass ValueError.
    assert not isinstance(caught.value, json.JSONDecodeError)


def test_a_well_formed_answer_still_parses():
    from contracts.rein_court import _llm_json

    w = world()
    w.prompt = lambda prompt: {"verdict": "compliant"}
    assert _llm_json("p", "the judge") == {"verdict": "compliant"}

    # Fenced JSON is recovered rather than rejected: models wrap it even when
    # told not to.
    w.prompt = lambda prompt: '```json\n{"verdict": "breach"}\n```'
    assert _llm_json("p", "the judge") == {"verdict": "breach"}


def test_nothing_a_leader_returns_is_a_float():
    """
    Calldata cannot encode a Python float. `calldata.encode({"a": 0.95})` raises
    `TypeError: not calldata encodable 0.95: float`, and the leader's return
    value is calldata-encoded on its way to the validators -- so a float
    anywhere in it fails the whole nondeterministic block, with no useful error.

    Confidence is the field that invites one, because models answer it as 0.95.
    It is carried as text for exactly this reason, and this test is what stops
    that being tidied away as redundant.
    """
    from contracts.rein_court import _check_facts, _judge_facts

    w = world()
    w.prompt = verdict_prompt(confidence=0.95)
    facts = json.dumps({"hash": TX, "from": AGENT.lower(), "to": "0xb"}, sort_keys=True)

    for produced in (
        _judge_facts(facts, MANDATE, AGENT.lower(), "desc"),
        _check_facts(facts, MANDATE, AGENT.lower(), "desc"),
        _judge_facts(NO_EVIDENCE, MANDATE, AGENT.lower(), ""),
        _check_facts(NO_EVIDENCE, MANDATE, AGENT.lower(), ""),
    ):
        for key, value in produced.items():
            assert not isinstance(value, float), f"{key} is a float: {value!r}"
            assert isinstance(value, str), f"{key} is {type(value).__name__}"
