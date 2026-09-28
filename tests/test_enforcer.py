import json
import pytest
from contracts.enforcer import Enforcer


def make_enforcer():
    """Create a fresh Enforcer with initialized state containers."""
    enf = Enforcer.__new__(Enforcer)
    enf.owner = "owner_addr"
    enf.court_address = "0xCourtAddr"
    enf.registry_address = "0xRegistryAddr"
    enf.revocations = {}
    enf.revocation_ids = []
    enf.total_revocations = 0
    enf.appeals = {}
    enf.appeal_ids = []
    enf.total_appeals = 0
    return enf


BREACH_VERDICT_HIGH = json.dumps({
    "verdict": "breach",
    "severity": "HIGH",
    "breached_clause": "never pay for ads",
    "reasoning": "Agent sent funds to ad platform",
    "confidence": 0.92,
})

BREACH_VERDICT_MED = json.dumps({
    "verdict": "breach",
    "severity": "MED",
    "breached_clause": "stay under budget",
    "reasoning": "Spending exceeded recommended amount",
    "confidence": 0.85,
})

BREACH_VERDICT_LOW = json.dumps({
    "verdict": "breach",
    "severity": "LOW",
    "breached_clause": "minor deviation",
    "reasoning": "Slight variation from mandate",
    "confidence": 0.7,
})

COMPLIANT_VERDICT = json.dumps({
    "verdict": "compliant",
    "severity": "LOW",
    "breached_clause": None,
    "reasoning": "Action within scope",
    "confidence": 0.95,
})


def test_initial_state():
    enf = make_enforcer()
    assert enf.total_revocations == 0
    assert enf.total_appeals == 0
    assert enf.owner == "owner_addr"
    assert enf.get_revocation_count() == 0
    assert enf.get_appeal_count() == 0


def test_execute_revocation_high():
    enf = make_enforcer()
    result = enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    r = json.loads(result)

    assert r["delegation_id"] == "del_001"
    assert r["verdict_id"] == "vrd_001"
    assert r["severity"] == "HIGH"
    assert r["status"] == "EXECUTED"
    assert r["evm_tx_hash"] == ""
    assert enf.total_revocations == 1


def test_execute_revocation_med():
    enf = make_enforcer()
    result = enf.execute_revocation("del_002", "vrd_002", BREACH_VERDICT_MED)
    r = json.loads(result)
    assert r["severity"] == "MED"
    assert r["status"] == "EXECUTED"


def test_execute_revocation_low_severity_rejected():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="Severity too low"):
        enf.execute_revocation("del_003", "vrd_003", BREACH_VERDICT_LOW)


def test_execute_revocation_compliant_rejected():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="breach"):
        enf.execute_revocation("del_004", "vrd_004", COMPLIANT_VERDICT)


def test_execute_revocation_invalid_json_raises():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="Invalid verdict JSON"):
        enf.execute_revocation("del_005", "vrd_005", "not valid json{{{")


def test_execute_revocation_empty_delegation_raises():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="delegation_id"):
        enf.execute_revocation("", "vrd_006", BREACH_VERDICT_HIGH)


def test_record_evm_revocation():
    enf = make_enforcer()
    result = enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    r = json.loads(result)
    rev_id = r["revocation_id"]

    enf.record_evm_revocation(rev_id, "0xEVMTxHash123")

    stored = json.loads(enf.get_revocation(rev_id))
    assert stored["evm_tx_hash"] == "0xEVMTxHash123"


def test_record_evm_revocation_unauthorized():
    enf = make_enforcer()
    result = enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    r = json.loads(result)
    rev_id = r["revocation_id"]

    from tests.conftest import mock_gl
    original = mock_gl.message.sender_address
    mock_gl.message.sender_address = "not_owner"

    with pytest.raises(ValueError, match="owner"):
        enf.record_evm_revocation(rev_id, "0xEVM")

    mock_gl.message.sender_address = original


def test_record_evm_revocation_not_found():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="not found"):
        enf.record_evm_revocation("fake_rev", "0xEVM")


def test_file_appeal():
    enf = make_enforcer()
    enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    rev_id = json.loads(enf.get_all_revocations())[0]["revocation_id"]

    result = enf.file_appeal(rev_id, "The action was within spirit of mandate", "1000000")
    a = json.loads(result)

    assert a["revocation_id"] == rev_id
    assert a["status"] == "PENDING"
    assert a["appeal_reason"] == "The action was within spirit of mandate"
    assert a["bond_amount"] == "1000000"
    assert enf.total_appeals == 1


def test_file_appeal_not_found():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="not found"):
        enf.file_appeal("fake_rev", "reason", "1000")


def test_file_appeal_empty_reason_raises():
    enf = make_enforcer()
    enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    rev_id = json.loads(enf.get_all_revocations())[0]["revocation_id"]

    with pytest.raises(ValueError, match="appeal_reason"):
        enf.file_appeal(rev_id, "", "1000")


def test_adjudicate_appeal_overturned():
    enf = make_enforcer()
    enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    rev_id = json.loads(enf.get_all_revocations())[0]["revocation_id"]
    enf.file_appeal(rev_id, "Was within mandate spirit", "1000")
    appeal_id = json.loads(enf.get_all_appeals())[0]["appeal_id"]

    from tests.conftest import mock_gl
    mock_gl.nondet.exec_prompt.return_value = json.dumps({
        "status": "OVERTURNED",
        "reasoning": "The action was indeed within the spirit of the mandate",
    })
    mock_gl.eq_principle.prompt_comparative.side_effect = lambda fn, prompt: fn()

    result = enf.adjudicate_appeal(appeal_id, "Buy compute only", "Bought GPU time")
    a = json.loads(result)
    assert a["status"] == "OVERTURNED"


def test_adjudicate_appeal_upheld():
    enf = make_enforcer()
    enf.execute_revocation("del_001", "vrd_001", BREACH_VERDICT_HIGH)
    rev_id = json.loads(enf.get_all_revocations())[0]["revocation_id"]
    enf.file_appeal(rev_id, "It was research adjacent", "2000")
    appeal_id = json.loads(enf.get_all_appeals())[0]["appeal_id"]

    from tests.conftest import mock_gl
    mock_gl.nondet.exec_prompt.return_value = json.dumps({
        "status": "UPHELD",
        "reasoning": "The agent clearly violated the ads prohibition",
    })
    mock_gl.eq_principle.prompt_comparative.side_effect = lambda fn, prompt: fn()

    result = enf.adjudicate_appeal(appeal_id, "Never pay for ads", "Bought ad placement")
    a = json.loads(result)
    assert a["status"] == "UPHELD"


def test_adjudicate_appeal_not_found():
    enf = make_enforcer()
    with pytest.raises(ValueError, match="not found"):
        enf.adjudicate_appeal("fake_apl", "mandate", "action")


def test_get_revocations_by_delegation():
    enf = make_enforcer()
    enf.execute_revocation("del_A", "v1", BREACH_VERDICT_HIGH)
    enf.execute_revocation("del_B", "v2", BREACH_VERDICT_MED)
    enf.execute_revocation("del_A", "v3", BREACH_VERDICT_HIGH)

    del_a = json.loads(enf.get_revocations_by_delegation("del_A"))
    assert len(del_a) == 2
    del_b = json.loads(enf.get_revocations_by_delegation("del_B"))
    assert len(del_b) == 1


def test_get_all_revocations():
    enf = make_enforcer()
    enf.execute_revocation("del_1", "v1", BREACH_VERDICT_HIGH)
    enf.execute_revocation("del_2", "v2", BREACH_VERDICT_MED)

    all_r = json.loads(enf.get_all_revocations())
    assert len(all_r) == 2


def test_get_all_appeals():
    enf = make_enforcer()
    enf.execute_revocation("del_1", "v1", BREACH_VERDICT_HIGH)
    rev_id = json.loads(enf.get_all_revocations())[0]["revocation_id"]
    enf.file_appeal(rev_id, "reason 1", "100")
    # File second appeal on a different revocation
    enf.execute_revocation("del_2", "v2", BREACH_VERDICT_MED)
    rev_id2 = json.loads(enf.get_all_revocations())[1]["revocation_id"]
    enf.file_appeal(rev_id2, "reason 2", "200")

    all_a = json.loads(enf.get_all_appeals())
    assert len(all_a) == 2


def test_critical_severity_revocation():
    critical = json.dumps({
        "verdict": "breach",
        "severity": "CRITICAL",
        "breached_clause": "never send to unknown addresses",
        "reasoning": "Funds sent to address created 2 days ago",
        "confidence": 0.99,
    })
    enf = make_enforcer()
    result = enf.execute_revocation("del_crit", "v_crit", critical)
    r = json.loads(result)
    assert r["severity"] == "CRITICAL"
    assert r["status"] == "EXECUTED"
