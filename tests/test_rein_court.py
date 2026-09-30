import json
import pytest
from contracts.rein_court import ReinCourt


def make_court():
    """Create a fresh ReinCourt with initialized state containers."""
    court = ReinCourt.__new__(ReinCourt)
    court.owner = "owner_addr"
    court.registry_address = "0xRegistryAddr"
    court.verdicts = {}
    court.verdict_ids = []
    court.total_verdicts = 0
    return court


def test_initial_state():
    court = make_court()
    assert court.total_verdicts == 0
    assert court.owner == "owner_addr"
    assert court.registry_address == "0xRegistryAddr"
    assert court.get_verdict_count() == 0


def test_review_action_stores_verdict():
    court = make_court()

    from tests.conftest import mock_gl, FakeResponse, judge_leader_only

    # Mock the web fetch and prompt
    mock_gl.nondet.web.get.return_value = FakeResponse('{"result": {"from": "0xAgent", "to": "0xTarget", "value": "0x100"}}')
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "compliant",
        "severity": "LOW",
        "breached_clause": None,
        "reasoning": "Action is within mandate scope",
        "confidence": 0.95,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    result = court.review_action(
        "del_001", "0xTxHash123", "1", "Bought compute credits", "Buy compute for research only"
    )
    v = json.loads(result)

    assert v["verdict"] == "compliant"
    assert v["severity"] == "LOW"
    assert v["delegation_id"] == "del_001"
    assert v["tx_hash"] == "0xTxHash123"
    assert court.total_verdicts == 1


def test_review_action_breach():
    court = make_court()

    from tests.conftest import mock_gl, FakeResponse, judge_leader_only

    mock_gl.nondet.web.get.return_value = FakeResponse('{"result": {"from": "0xAgent", "to": "0xAdPlatform"}}')
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "breach",
        "severity": "HIGH",
        "breached_clause": "never pay for ads",
        "reasoning": "Transaction sent funds to an advertising platform",
        "confidence": 0.92,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    result = court.review_action(
        "del_002", "0xTxHash456", "8453", "Bought ad placement", "Buy compute for research, never pay for ads"
    )
    v = json.loads(result)

    assert v["verdict"] == "breach"
    assert v["severity"] == "HIGH"
    assert v["breached_clause"] == "never pay for ads"


def test_review_action_empty_delegation_raises():
    court = make_court()
    with pytest.raises(ValueError, match="delegation_id"):
        court.review_action("", "0xTx", "1", "desc", "mandate")


def test_review_action_empty_tx_raises():
    court = make_court()
    with pytest.raises(ValueError, match="tx_hash"):
        court.review_action("del_1", "", "1", "desc", "mandate")


def test_review_action_empty_mandate_raises():
    court = make_court()
    with pytest.raises(ValueError, match="mandate_text"):
        court.review_action("del_1", "0xTx", "1", "desc", "")


def test_get_verdict_not_found():
    court = make_court()
    with pytest.raises(ValueError, match="not found"):
        court.get_verdict("nonexistent")


def test_get_verdict_retrieves_stored():
    court = make_court()

    from tests.conftest import mock_gl, FakeResponse, judge_leader_only

    mock_gl.nondet.web.get.return_value = FakeResponse('{"result": {}}')
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "ambiguous",
        "severity": "LOW",
        "breached_clause": None,
        "reasoning": "Insufficient evidence",
        "confidence": 0.5,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    result = court.review_action("del_x", "0xTx", "1", "something", "do stuff")
    v = json.loads(result)
    vid = v["verdict_id"]

    stored = json.loads(court.get_verdict(vid))
    assert stored["verdict"] == "ambiguous"
    assert stored["verdict_id"] == vid


def test_get_verdicts_by_delegation():
    court = make_court()

    from tests.conftest import mock_gl, FakeResponse, judge_leader_only

    mock_gl.nondet.web.get.return_value = FakeResponse('{"result": {}}')
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "compliant", "severity": "LOW",
        "breached_clause": None, "reasoning": "ok", "confidence": 0.9,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    court.review_action("del_A", "0xTx1", "1", "action 1", "mandate A")
    court.review_action("del_B", "0xTx2", "1", "action 2", "mandate B")
    court.review_action("del_A", "0xTx3", "1", "action 3", "mandate A")

    del_a = json.loads(court.get_verdicts_by_delegation("del_A"))
    assert len(del_a) == 2
    del_b = json.loads(court.get_verdicts_by_delegation("del_B"))
    assert len(del_b) == 1


def test_get_recent_verdicts():
    court = make_court()

    from tests.conftest import mock_gl, FakeResponse, judge_leader_only

    mock_gl.nondet.web.get.return_value = FakeResponse('{"result": {}}')
    mock_gl.nondet.exec_prompt.return_value = ({
        "verdict": "compliant", "severity": "LOW",
        "breached_clause": None, "reasoning": "ok", "confidence": 0.9,
    })
    mock_gl.eq_principle.prompt_non_comparative.side_effect = judge_leader_only

    for i in range(5):
        court.review_action(f"del_{i}", f"0xTx{i}", "1", f"action {i}", "mandate")

    recent = json.loads(court.get_recent_verdicts(3))
    assert len(recent) == 3
    # Should be in reverse order (most recent first)
    assert "del_4" in recent[0]["delegation_id"]


def test_explorer_url_selection():
    court = make_court()
    # Every chain the UI offers must be resolvable.
    for chain in ("1", "8453", "137", "42161", "11155111"):
        assert chain in court.EXPLORER_URLS, chain
        assert court.EXPLORER_URLS[chain], chain

    # Blockscout only. Etherscan's V1 proxy endpoint is retired and answers 200
    # with an error body, which the fetch loop accepted as evidence and then
    # stopped on, so the judge only ever saw an error page.
    for chain, urls in court.EXPLORER_URLS.items():
        for url in urls:
            assert "blockscout.com" in url, (chain, url)
            assert "etherscan" not in url, (chain, url)
            assert "basescan" not in url, (chain, url)
