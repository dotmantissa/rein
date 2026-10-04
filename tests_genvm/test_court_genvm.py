"""
Run ReinCourt in a real local GenVM.

StudioNet reported `review_action` as "GenVM crashed 3 times with a
non-classifiable internal error", with a memory fingerprint and no stack trace.
This reproduces the call against the real GenVM Python SDK and real storage, so
a crash in the contract body shows up with a traceback.

Two caveats, both deliberate:

* The direct loader allows one contract per process, so MandateRegistry is not
  deployed. The cross-contract read is served by `_gl_call_hook` instead, which
  is the same seam the simulator uses, and it returns a record produced by the
  real registry code so the court is not fed a hand-written shape.
* Direct mode patches out the cloudpickle step in `run_nondet`. A crash caused
  by pickling the leader and validator closures therefore cannot appear here,
  and `test_closures_are_picklable` covers that separately.
"""

import json
import sys

import pytest

AGENT = "0xdc81c69f8d9de93349ac9def1454eabb1d3d58dc"
HOST_REGISTRY = "0xd20055953d51efb3612cac51cfe1d6c29fd592d5"
REGISTRY_ADDR = "0x0ab7e3a605dfad5fbd8f8ee11b485e370812f87d"
TX = "0xb48189b604afec8bcc8c6fc90223e5a6ef4d38714b48ac52deaddfc26cda88a4"
DELEGATION_ID = "del_0ab7e3a6_BC1399c5_dC81c69F_0"
CHAIN = "11155111"

MANDATE = (
    "Buy research compute only. Only ever transact with the approved vendor "
    "contract at 0x1111111111111111111111111111111111111111. Never send a "
    "transaction to any other contract or address. Never pay for advertising."
)

MANDATE_RECORD = {
    "delegation_id": DELEGATION_ID,
    "delegator": "0xbc1399c55538ec034d4da550c03c34ae0c357f53",
    "agent_address": AGENT,
    "mandate_text": MANDATE,
    "mandate_hash": "0x67beb1af804415cac86c1e22752469873a2576f3d7b76adc3d17a43ad935ac78",
    "spend_ceiling_wei": "1000000000000000",
    "chain_id": CHAIN,
    "session_key_id": AGENT,
    "host_registry": HOST_REGISTRY,
    "host_delegation_id": "0x0dca7f0182a769c9efa37f016387c50c477e9cdcb693e3fa29dcc366e2b6dfca",
    "status": "ACTIVE",
    "action_count": 0,
    "registered_by": "0xbc1399c55538ec034d4da550c03c34ae0c357f53",
}

EXPLORER_BODY = json.dumps(
    {
        "hash": TX,
        "from": {"hash": AGENT, "is_contract": False},
        "to": {"hash": HOST_REGISTRY, "is_contract": True},
        "value": "0",
        "gas_used": "68795",
        "status": "ok",
        "method": "0x28cc1c7f",
        "raw_input": "0x28cc1c7f",
        "confirmations": 12,
        "timestamp": "2026-10-03T01:00:00.000000Z",
    }
)

# Confidence is quoted on purpose. Calldata cannot encode a Python float --
# `calldata.encode({"a": 0.95})` raises `TypeError: not calldata encodable` --
# and every value crossing the VM boundary goes through calldata. That is why
# `_judge_facts` returns confidence as text rather than as a number: a float in
# the leader's return value would fail to encode on the way to the validators.
JUDGE_ANSWER = json.dumps(
    {
        "verdict": "breach",
        "severity": "HIGH",
        "breached_clause": "Never send a transaction to any other contract or address.",
        "reasoning": "The transaction went to an address that is not the approved vendor.",
        "confidence": "0.95",
    }
)


def _serve_registry(vm, request):
    """
    Answer the court's cross-contract reads and swallow its emits.

    The GenVM SDK is loaded by the direct loader rather than installed, so
    `calldata` is only importable once a contract has been deployed.
    """
    from genlayer.py import calldata

    if "CallContract" in request:
        call = request["CallContract"]
        method = call.get("calldata", {}).get("method")
        if method == "get_mandate":
            # A sub-VM result, which is a ResultCode byte followed by calldata.
            # The SDK decodes a cross-contract read with _decode_sub_vm_result,
            # so a plain {"ok": ...} is read as a failure and the court reports
            # the delegation as unregistered.
            return bytes([0]) + calldata.encode(
                json.dumps(MANDATE_RECORD, sort_keys=True)
            )
        raise AssertionError(f"unexpected cross-contract view {method}")
    if "PostMessage" in request:
        # increment_action_count, queued for after the transaction settles.
        vm._trace(f"emit {request['PostMessage'].get('calldata', {}).get('method')}")
        return {"ok": None}
    return None


def _court_module(direct_deploy, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    court = direct_deploy("contracts/rein_court.py", REGISTRY_ADDR)
    return court, sys.modules[type(court).__module__]


def test_evidence_is_fetched_and_reduced_in_the_genvm(
    direct_vm, direct_deploy, direct_owner
):
    """The leader's evidence step, against the real SDK's Response object."""
    court, mod = _court_module(direct_deploy, direct_vm, direct_owner)
    direct_vm.mock_web(
        r".*blockscout\.com/api/v2/transactions/.*",
        {"status": 200, "body": EXPLORER_BODY},
    )

    facts = json.loads(mod._fetch_facts(mod.EXPLORER_URLS[CHAIN], TX))

    assert facts["hash"] == TX
    assert facts["from"] == AGENT
    assert facts["to"] == HOST_REGISTRY
    # Volatile fields must not reach the judge, or two validators end up
    # comparing different evidence for the same transaction.
    assert "confirmations" not in facts
    assert "timestamp" not in facts


def test_the_judge_runs_in_the_genvm(direct_vm, direct_deploy, direct_owner):
    """
    The judging path on fixed evidence, in a real GenVM: attribution check,
    prompt, parse, normalise.

    The fetch is covered by the test above rather than here. This harness serves
    web and LLM mocks from one context, and a web call consumed first leaves the
    following `exec_prompt` unmocked -- a harness limitation, not something the
    contract does. Keeping the two steps in separate tests exercises both
    against the real SDK without tripping over it.
    """
    court, mod = _court_module(direct_deploy, direct_vm, direct_owner)
    direct_vm.mock_llm(r"(?s)REIN", JUDGE_ANSWER)

    facts = json.dumps(
        {"hash": TX, "from": AGENT, "to": HOST_REGISTRY, "value_wei": "0"},
        sort_keys=True,
    )
    verdict = mod._judge_facts(facts, MANDATE, AGENT, "Bought GPU time")

    assert verdict["verdict"] == "breach"
    assert verdict["severity"] == "HIGH"
    assert verdict["attributed"] == "true"
    assert verdict["facts"] == facts
    # Confidence crosses the calldata boundary as text, so no float travels
    # between the leader and the validators.
    assert isinstance(verdict["confidence"], str)
    assert float(verdict["confidence"]) == 0.95

    # Nothing a leader returns may be a float: calldata cannot encode one, and
    # the leader's return value is calldata-encoded on its way to the validators.
    from genlayer.py import calldata

    calldata.encode(verdict)
    assert not any(isinstance(v, float) for v in verdict.values())

    # The validator's compact re-decision, on the same evidence, agrees.
    mine = mod._check_facts(facts, MANDATE, AGENT, "Bought GPU time")
    calldata.encode(mine)
    assert mod._verdicts_agree(verdict, mine)


def test_an_empty_model_answer_is_an_llm_error_not_a_vm_crash(
    direct_vm, direct_deploy, direct_owner
):
    """
    The defect this file was written to find.

    `_parse_llm_json` raises whatever `json` raises, and a bare Python exception
    inside a nondeterministic block is unrecoverable in GenVM: it takes the VM
    down. StudioNet reported it as "GenVM crashed 3 times with a
    non-classifiable internal error" and settled the transaction as CANCELED
    with NO_MAJORITY and zero leader and validator receipts, which reads exactly
    like validators disagreeing.

    A model answering nothing is the common way in, and it has to come out as a
    classified [LLM_ERROR] so the leader is rotated.
    """
    court, mod = _court_module(direct_deploy, direct_vm, direct_owner)
    direct_vm.mock_llm(r"(?s)REIN", "")

    with pytest.raises(Exception) as caught:
        mod._judge_facts('{"hash": "%s", "from": "%s"}' % (TX, AGENT), MANDATE, AGENT, "")

    assert isinstance(caught.value, mod.gl.vm.UserError)
    assert "[LLM_ERROR]" in caught.value.message


def test_a_transaction_from_another_account_is_not_judged(
    direct_vm, direct_deploy, direct_owner
):
    """No prompt is spent on an action the registered agent did not take."""
    court, mod = _court_module(direct_deploy, direct_vm, direct_owner)
    stranger = "0x9999999999999999999999999999999999999999"
    facts = json.dumps({"hash": TX, "from": stranger, "to": HOST_REGISTRY}, sort_keys=True)

    out = mod._judge_facts(facts, MANDATE, AGENT, "")
    assert out["facts"] == mod.NOT_THIS_AGENT
    assert out["attributed"] == "false"
    assert out["verdict"] == "ambiguous"


def test_closures_are_picklable(direct_vm, direct_deploy, direct_owner):  # noqa: D401
    """
    The leader and validator closures are cloudpickled and shipped to the
    validators on a real network. Direct mode patches that step out, so it is
    checked explicitly here: a closure that cannot be pickled, or that drags the
    whole SDK in by value, crashes the VM with no usable error.
    """
    import cloudpickle

    direct_vm.sender = direct_owner
    court = direct_deploy("contracts/rein_court.py", REGISTRY_ADDR)
    # The loader imports the contract under a synthetic module name.
    court_mod = sys.modules[type(court).__module__]

    urls = court_mod.EXPLORER_URLS[CHAIN]
    facts = json.dumps({"hash": TX, "from": AGENT, "to": HOST_REGISTRY}, sort_keys=True)

    def _leader():
        return court_mod._judge_facts(
            court_mod._fetch_facts(urls, TX), MANDATE, AGENT, "desc"
        )

    def _validator(res):
        return court_mod._verdicts_agree(
            {"verdict": "breach"}, court_mod._check_facts(facts, MANDATE, AGENT, "desc")
        )

    leader_blob = cloudpickle.dumps(lambda _: _leader())
    validator_blob = cloudpickle.dumps(_validator)

    # Both must round-trip, and neither should be enormous: the blob travels
    # with every nondet call.
    assert cloudpickle.loads(leader_blob) is not None
    assert cloudpickle.loads(validator_blob) is not None
    assert len(leader_blob) < 2_000_000, f"leader closure is {len(leader_blob)} bytes"
    assert len(validator_blob) < 2_000_000, f"validator closure is {len(validator_blob)} bytes"
