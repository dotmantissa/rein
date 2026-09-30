"""
Regression tests for how the court decides what counts as evidence.

Each test here corresponds to a defect that shipped. The court judged every
transaction it was ever given on the submitter's own description of what
happened, because its first explorer URL was Etherscan's retired V1 proxy
endpoint, which answers HTTP 200 with an error body. The fetch loop accepted any
2xx response longer than ten characters and stopped there, so the error page
became the evidence and the working fallback was never reached.
"""

import json
import pytest
from contracts.rein_court import ReinCourt, _extract_tx_facts
from tests.conftest import mock_gl, FakeResponse, judge_leader_only

TX = "0xb740caf4efcbf64e9c39b403b4ea1b6974e721969a893a994b95ad1038c140f3"

# Trimmed from a real eth.blockscout.com response for the transaction above.
REAL_BODY = json.dumps({
    "hash": TX,
    "from": {"hash": "0x2Ff47E818Bf4798d0639F9d75Af2d5fD55eC3c78", "is_contract": False},
    "to": {"hash": "0xb6E0EdaEfC86338a9ed27f794624096e4a341ED7", "is_contract": False},
    "value": "37407860000000000000",
    "gas_used": "21000",
    "status": "ok",
    "method": None,
    "raw_input": "0x",
    "confirmations": 12,
    "timestamp": "2026-09-30T01:00:00.000000Z",
})

# What api.etherscan.io actually returns now, with a 200 status.
ETHERSCAN_V1_ERROR = json.dumps({
    "status": "0",
    "message": "NOTOK",
    "result": "You are using a deprecated V1 endpoint, switch to Etherscan API V2 "
              "using https://docs.etherscan.io/v2-migration",
})


def facts_block(prompt: str) -> str:
    """
    Pull out the evidence the judge was actually given.

    The sentinel's name necessarily appears in the prompt's instructions, so
    searching the whole prompt for it proves nothing. Only the block under the
    FACTS heading says what was judged.
    """
    marker = "VERIFIED TRANSACTION FACTS"
    assert marker in prompt
    after = prompt.split(marker, 1)[1]
    # Skip the remainder of the heading line, then take the next non-empty line.
    for line in after.split("\n")[1:]:
        if line.strip():
            return line.strip()
    raise AssertionError("no facts block in prompt")


def make_court():
    court = ReinCourt.__new__(ReinCourt)
    court.owner = "owner_addr"
    court.registry_address = "0xRegistryAddr"
    court.verdicts = {}
    court.verdict_ids = []
    court.total_verdicts = 0
    return court


def test_deprecated_endpoint_error_is_not_evidence():
    # A 200 carrying an error body must not pass as a transaction record.
    assert _extract_tx_facts(ETHERSCAN_V1_ERROR, TX) == ""


def test_response_for_a_different_transaction_is_rejected():
    # Well-formed, but describes something else. Accepting it would attribute
    # one agent's action to another's mandate.
    assert _extract_tx_facts(REAL_BODY, "0x" + "ab" * 32) == ""


@pytest.mark.parametrize("body", ["", "<html>502 Bad Gateway</html>", "[1,2,3]", "null"])
def test_malformed_bodies_are_rejected(body):
    assert _extract_tx_facts(body, TX) == ""


def test_facts_are_extracted_from_a_real_response():
    facts = json.loads(_extract_tx_facts(REAL_BODY, TX))
    assert facts["hash"] == TX
    assert facts["value_wei"] == "37407860000000000000"
    assert facts["gas_used"] == "21000"
    assert facts["status"] == "ok"
    # Addresses arrive as objects and must be flattened, and lowercased so two
    # validators cannot disagree over checksum casing.
    assert facts["from"] == "0x2ff47e818bf4798d0639f9d75af2d5fd55ec3c78"
    assert facts["to"] == "0xb6e0edaefc86338a9ed27f794624096e4a341ed7"


def test_volatile_fields_do_not_change_the_evidence():
    """
    Validators fetch independently, so confirmation counts and timestamps differ
    between them. Passing raw JSON to the judge meant each one prompted on
    slightly different text and they could fail to agree.
    """
    later = json.loads(REAL_BODY)
    later["confirmations"] = 999999
    later["timestamp"] = "2099-01-01T00:00:00.000000Z"
    assert _extract_tx_facts(json.dumps(later), TX) == _extract_tx_facts(REAL_BODY, TX)


def test_extraction_is_stable_across_key_order():
    shuffled = json.loads(REAL_BODY)
    shuffled = {k: shuffled[k] for k in reversed(list(shuffled))}
    assert _extract_tx_facts(json.dumps(shuffled), TX) == _extract_tx_facts(REAL_BODY, TX)


def test_approval_amount_reaches_the_judge():
    """
    An approval is only a breach because of its amount. Without the decoded
    arguments the judge could see that approve() was called but not that it was
    for the whole balance, so "never grant an unlimited allowance" was
    unenforceable.
    """
    max_uint = str(2**256 - 1)
    body = json.dumps({
        "hash": TX,
        "from": {"hash": "0xAgent"},
        "to": {"hash": "0xToken"},
        "value": "0",
        "gas_used": "47242",
        "status": "ok",
        "method": "approve",
        "raw_input": "0x095ea7b3deadbeef",
        "decoded_input": {
            "method_call": "approve(address spender, uint256 value)",
            "parameters": [
                {"name": "spender", "value": "0xRouter"},
                {"name": "value", "value": max_uint},
            ],
        },
    })
    facts = json.loads(_extract_tx_facts(body, TX))
    assert facts["method"] == "approve"
    assert facts["arguments"]["value"] == max_uint[:80]
    assert facts["method_call"].startswith("approve(")


def test_argument_values_are_bounded():
    # Calldata blobs are unbounded. Building the whole string before truncating
    # it is what crashed the VM when the raw response was stringified.
    body = json.dumps({
        "hash": TX, "from": {"hash": "0xA"}, "to": {"hash": "0xB"},
        "value": "0", "gas_used": "1", "status": "ok",
        "decoded_input": {
            "method_call": "execute(bytes commands)",
            "parameters": [{"name": "commands", "value": "0x" + "ff" * 5000}],
        },
    })
    facts = json.loads(_extract_tx_facts(body, TX))
    assert len(facts["arguments"]["commands"]) <= 80


def test_token_symbols_reach_the_judge():
    body = json.dumps({
        "hash": TX, "from": {"hash": "0xA"}, "to": {"hash": "0xB"},
        "value": "0", "gas_used": "1", "status": "ok",
        "token_transfers": [
            {"token": {"symbol": "USDC", "address": "0xUSDC"},
             "from": {"hash": "0xA"}, "to": {"hash": "0xPool"}},
            {"token": {"symbol": "STRCX", "address": "0xSTRCX"},
             "from": {"hash": "0xPool"}, "to": {"hash": "0xA"}},
        ],
    })
    facts = json.loads(_extract_tx_facts(body, TX))
    symbols = sorted(t["token"] for t in facts["token_transfers"])
    assert symbols == ["STRCX", "USDC"]


def test_unreachable_explorer_yields_the_shared_sentinel():
    """
    When nothing can be verified, every validator must prompt on identical text.
    Letting each one embed its own error page is how they end up disagreeing.
    """
    court = make_court()
    mock_gl.nondet.web.get.return_value = FakeResponse(ETHERSCAN_V1_ERROR, status=200)
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "ambiguous", "severity": "LOW", "breached_clause": None,
        "reasoning": "No verifiable transaction data was available.", "confidence": 0.1,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    court.review_action("del_1", TX, "1", "Agent did something", "Never do anything")

    prompt = mock_gl.nondet.exec_prompt.call_args[0][0]
    assert facts_block(prompt) == court.NO_EVIDENCE
    # The error page itself must not leak in as evidence.
    assert "NOTOK" not in prompt
    assert "deprecated" not in prompt


def test_judge_sees_facts_and_not_the_raw_response():
    court = make_court()
    mock_gl.nondet.web.get.return_value = FakeResponse(REAL_BODY)
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "breach", "severity": "HIGH",
        "breached_clause": "never move more than 1 ETH in a single transaction",
        "reasoning": "The transaction moved 37.4 ETH.", "confidence": 0.98,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    result = json.loads(court.review_action(
        "del_2", TX, "1", "Agent moved funds",
        "It must never move more than 1 ETH in a single transaction.",
    ))

    prompt = mock_gl.nondet.exec_prompt.call_args[0][0]
    facts = facts_block(prompt)
    assert facts.startswith("{")                    # real evidence, not the sentinel
    assert facts != court.NO_EVIDENCE
    assert "37407860000000000000" in facts          # the fact that decides it
    assert "confirmations" not in prompt            # volatile noise, excluded
    assert "timestamp" not in facts
    assert result["verdict"] == "breach"
    assert court.total_verdicts == 1


def test_description_alone_cannot_manufacture_a_breach():
    """
    The submitter's description is an unverified claim. The prompt has to say so,
    or the contract is just restating whoever filed the review.
    """
    court = make_court()
    mock_gl.nondet.web.get.return_value = FakeResponse(REAL_BODY)
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "compliant", "severity": "LOW", "breached_clause": None,
        "reasoning": "ok", "confidence": 0.9,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    court.review_action("del_3", TX, "1", "Agent stole everything", "Do not steal")

    prompt = mock_gl.nondet.exec_prompt.call_args[0][0]
    assert "unverified" in prompt.lower()
    assert "never treat it as proof" in prompt
