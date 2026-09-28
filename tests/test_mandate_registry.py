import json
import pytest
from contracts.mandate_registry import MandateRegistry


def make_registry():
    """Create a fresh MandateRegistry with initialized state containers."""
    reg = MandateRegistry()
    reg.mandates = {}
    reg.mandate_ids = []
    reg.total_mandates = 0
    reg.owner = "owner_addr"
    return reg


def test_initial_state():
    reg = make_registry()
    assert reg.total_mandates == 0
    assert reg.owner == "owner_addr"
    assert reg.get_mandate_count() == 0
    all_m = json.loads(reg.get_all_mandates())
    assert all_m == []


def test_register_mandate_basic():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "Buy compute only", "1000000", "1", "sess_abc")
    assert did is not None
    assert "del1" in did or "del_del1" in did
    assert reg.total_mandates == 1


def test_register_mandate_stores_correct_data():
    reg = make_registry()
    did = reg.register_mandate(
        "0xDelegator", "0xAgent", "Never buy ads, only compute", "5000000", "8453", "key_123"
    )
    m = json.loads(reg.get_mandate(did))
    assert m["delegator"] == "0xDelegator"
    assert m["agent_address"] == "0xAgent"
    assert m["mandate_text"] == "Never buy ads, only compute"
    assert m["spend_ceiling_wei"] == "5000000"
    assert m["chain_id"] == "8453"
    assert m["session_key_id"] == "key_123"
    assert m["status"] == "ACTIVE"
    assert m["action_count"] == 0
    assert m["delegation_id"] == did


def test_register_multiple_mandates():
    reg = make_registry()
    did1 = reg.register_mandate("del1", "agent1", "mandate one", "100", "1", "s1")
    did2 = reg.register_mandate("del2", "agent2", "mandate two", "200", "8453", "s2")
    assert did1 != did2
    assert reg.total_mandates == 2

    all_m = json.loads(reg.get_all_mandates())
    assert len(all_m) == 2


def test_register_mandate_empty_delegator_raises():
    reg = make_registry()
    with pytest.raises(ValueError, match="delegator"):
        reg.register_mandate("", "agent1", "mandate", "100", "1", "s1")


def test_register_mandate_empty_agent_raises():
    reg = make_registry()
    with pytest.raises(ValueError, match="agent_address"):
        reg.register_mandate("del1", "", "mandate", "100", "1", "s1")


def test_register_mandate_empty_text_raises():
    reg = make_registry()
    with pytest.raises(ValueError, match="mandate_text"):
        reg.register_mandate("del1", "agent1", "", "100", "1", "s1")


def test_get_mandate_not_found():
    reg = make_registry()
    with pytest.raises(ValueError, match="not found"):
        reg.get_mandate("nonexistent_id")


def test_get_mandates_by_delegator():
    reg = make_registry()
    reg.register_mandate("alice", "agent1", "mandate A", "100", "1", "s1")
    reg.register_mandate("bob", "agent2", "mandate B", "200", "1", "s2")
    reg.register_mandate("alice", "agent3", "mandate C", "300", "1", "s3")

    alice_mandates = json.loads(reg.get_mandates_by_delegator("alice"))
    assert len(alice_mandates) == 2
    bob_mandates = json.loads(reg.get_mandates_by_delegator("bob"))
    assert len(bob_mandates) == 1
    nobody = json.loads(reg.get_mandates_by_delegator("nobody"))
    assert len(nobody) == 0


def test_update_status_by_owner():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "mandate", "100", "1", "s1")

    reg.update_status(did, "FLAGGED")
    m = json.loads(reg.get_mandate(did))
    assert m["status"] == "FLAGGED"

    reg.update_status(did, "REVOKED")
    m = json.loads(reg.get_mandate(did))
    assert m["status"] == "REVOKED"

    reg.update_status(did, "RESTORED")
    m = json.loads(reg.get_mandate(did))
    assert m["status"] == "RESTORED"


def test_update_status_invalid_raises():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "mandate", "100", "1", "s1")
    with pytest.raises(ValueError, match="Invalid status"):
        reg.update_status(did, "BOGUS")


def test_update_status_unauthorized_raises():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "mandate", "100", "1", "s1")
    # Change sender to someone who is neither owner nor delegator
    from tests.conftest import mock_gl, MockSender
    original_sender = mock_gl.message.sender_address
    mock_gl.message.sender_address = "unauthorized_addr"

    with pytest.raises(ValueError, match="owner or the mandate delegator"):
        reg.update_status(did, "FLAGGED")

    # Restore
    mock_gl.message.sender_address = original_sender


def test_update_status_not_found_raises():
    reg = make_registry()
    with pytest.raises(ValueError, match="not found"):
        reg.update_status("fake_id", "FLAGGED")


def test_increment_action_count():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "mandate", "100", "1", "s1")

    reg.increment_action_count(did)
    m = json.loads(reg.get_mandate(did))
    assert m["action_count"] == 1

    reg.increment_action_count(did)
    m = json.loads(reg.get_mandate(did))
    assert m["action_count"] == 2


def test_increment_action_count_unauthorized_raises():
    reg = make_registry()
    did = reg.register_mandate("del1", "agent1", "mandate", "100", "1", "s1")

    from tests.conftest import mock_gl
    original_sender = mock_gl.message.sender_address
    mock_gl.message.sender_address = "not_owner"

    with pytest.raises(ValueError, match="owner"):
        reg.increment_action_count(did)

    mock_gl.message.sender_address = original_sender


def test_increment_action_count_not_found_raises():
    reg = make_registry()
    with pytest.raises(ValueError, match="not found"):
        reg.increment_action_count("fake_id")


def test_mandate_hash_uniqueness():
    reg = make_registry()
    did1 = reg.register_mandate("del1", "agent1", "same text", "100", "1", "s1")
    did2 = reg.register_mandate("del1", "agent1", "same text", "100", "1", "s1")
    m1 = json.loads(reg.get_mandate(did1))
    m2 = json.loads(reg.get_mandate(did2))
    # Different nonces should produce different hashes
    assert m1["mandate_hash"] != m2["mandate_hash"]
