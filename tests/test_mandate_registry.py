"""
MandateRegistry: the record every other contract reads from.

The court is handed a delegation_id and reads the mandate, the agent and the
chain from here, and the enforcer reads the host-chain coordinates from here, so
a record that is wrong or editable undermines everything downstream. These tests
cover what the registry refuses to store and who is allowed to move a mandate
between states.
"""

import json
import pytest

from tests.builders import (
    AGENT,
    DELEGATOR,
    ENFORCER_ADDR,
    HOST_REGISTRY,
    MANDATE,
    RELAYER,
    SESSION_KEY,
    STRANGER,
    deploy_stack,
    register,
)
from tests.conftest import keccak_hex, world


def test_registration_stores_the_record_the_court_will_read():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)

    m = json.loads(w.call(registry, "get_mandate", did))
    assert m["delegation_id"] == did
    assert m["mandate_text"] == MANDATE
    assert m["agent_address"] == AGENT.lower()
    assert m["delegator"] == DELEGATOR.lower()
    assert m["chain_id"] == "11155111"
    assert m["status"] == "ACTIVE"
    assert m["action_count"] == 0
    assert w.call(registry, "get_mandate_count") == 1


def test_mandate_hash_is_keccak_of_the_text():
    """
    The commitment used to be Python's hash(), which is salted per process. Two
    validators hashing the same mandate produced different values, so the field
    committed to nothing and the enforcer could not use it to detect an edited
    mandate.
    """
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)

    m = json.loads(w.call(registry, "get_mandate", did))
    assert m["mandate_hash"] == keccak_hex(MANDATE)
    assert m["mandate_hash"] != keccak_hex(MANDATE + " ")


def test_host_delegation_handle_matches_the_solidity_derivation():
    """
    ReinSessionKeyRegistry keys delegations by keccak256(bytes(delegation_id)).
    Deriving it here, rather than accepting it as an argument, is what stops the
    two chains being pointed at different delegations.
    """
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)

    m = json.loads(w.call(registry, "get_mandate", did))
    assert m["host_delegation_id"] == keccak_hex(did)
    assert m["host_registry"] == HOST_REGISTRY
    assert m["session_key_id"] == SESSION_KEY.lower()


@pytest.mark.parametrize(
    "field,value,msg",
    [
        ("delegator", "", "delegator"),
        ("delegator", "not-an-address", "delegator"),
        ("agent", "", "agent_address"),
        ("agent", "0xabc", "agent_address"),
        ("session_key", "sess_123", "session_key_id"),
        ("host_registry", "nope", "host_registry"),
        ("ceiling", "-5", "spend_ceiling_wei"),
        ("ceiling", "a lot", "spend_ceiling_wei"),
    ],
)
def test_unusable_fields_are_refused(field, value, msg):
    """
    The court binds a review to the agent by comparing a transaction's sender
    against agent_address, and the enforcer addresses the host chain with these
    values. Junk here produces a delegation that cannot be judged or enforced,
    so it is refused at the door rather than discovered later.
    """
    w = world()
    registry, _, _ = deploy_stack(w)
    with pytest.raises(ValueError, match=msg):
        register(w, registry, **{field: value})


def test_empty_mandate_text_is_refused():
    w = world()
    registry, _, _ = deploy_stack(w)
    with pytest.raises(ValueError, match="mandate_text"):
        register(w, registry, mandate_text="   ")


def test_unsupported_chain_is_refused():
    """
    A mandate on a chain the court cannot fetch evidence for would be
    permanently unjudgeable, which is worse than being rejected.
    """
    w = world()
    registry, _, _ = deploy_stack(w)
    with pytest.raises(ValueError, match="Unsupported chain_id"):
        register(w, registry, chain="999999")


def test_delegator_can_flag_and_revoke_their_own_agent():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)

    w.call(registry, "update_status", did, "FLAGGED", sender=DELEGATOR)
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "FLAGGED"

    w.call(registry, "update_status", did, "REVOKED", sender=DELEGATOR)
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"
    assert w.call(registry, "is_live", did) is False


def test_a_stranger_cannot_touch_someone_elses_mandate():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)

    with pytest.raises(ValueError, match="Only"):
        w.call(registry, "update_status", did, "REVOKED", sender=STRANGER)


def test_only_the_enforcer_can_restore_a_revoked_delegation():
    """
    "The operator cannot veto it" is the whole premise. An operator who could
    set their own revoked mandate back to RESTORED would be vetoing the court,
    so restoration is reachable from the enforcer and nowhere else -- not even
    from the contract owner.
    """
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)
    w.call(registry, "update_status", did, "REVOKED", sender=DELEGATOR)

    with pytest.raises(ValueError, match="Only the Enforcer"):
        w.call(registry, "update_status", did, "RESTORED", sender=DELEGATOR)
    with pytest.raises(ValueError, match="Only the Enforcer"):
        w.call(registry, "update_status", did, "RESTORED", sender=RELAYER)

    w.call(registry, "update_status", did, "RESTORED", sender=ENFORCER_ADDR)
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "RESTORED"
    assert w.call(registry, "is_live", did) is True


def test_a_revoked_mandate_cannot_be_walked_back_to_active():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)
    w.call(registry, "update_status", did, "REVOKED", sender=DELEGATOR)

    with pytest.raises(ValueError, match="Cannot move a mandate from REVOKED"):
        w.call(registry, "update_status", did, "ACTIVE", sender=RELAYER)


def test_repeating_the_current_status_is_a_no_op():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)
    w.call(registry, "update_status", did, "ACTIVE", sender=RELAYER)
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "ACTIVE"


def test_invalid_status_is_refused():
    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)
    with pytest.raises(ValueError, match="Invalid status"):
        w.call(registry, "update_status", did, "CANCELLED", sender=RELAYER)


def test_unknown_mandate_is_not_found():
    w = world()
    registry, _, _ = deploy_stack(w)
    with pytest.raises(ValueError, match="not found"):
        w.call(registry, "get_mandate", "del_nope")
    with pytest.raises(ValueError, match="not found"):
        w.call(registry, "update_status", "del_nope", "FLAGGED", sender=RELAYER)
    assert w.call(registry, "is_live", "del_nope") is False


def test_action_count_is_only_writable_by_the_court():
    w = world()
    registry, court, _ = deploy_stack(w)
    did = register(w, registry)

    with pytest.raises(ValueError, match="Only the court"):
        w.call(registry, "increment_action_count", did, sender=STRANGER)

    w.call(registry, "increment_action_count", did, sender=w.address_of(court))
    assert json.loads(w.call(registry, "get_mandate", did))["action_count"] == 1


def test_only_the_owner_can_rewire_the_registry():
    w = world()
    registry, _, _ = deploy_stack(w)
    with pytest.raises(ValueError, match="Only the contract owner"):
        w.call(registry, "set_enforcer", STRANGER, sender=STRANGER)
    with pytest.raises(ValueError, match="Only the contract owner"):
        w.call(registry, "set_court", STRANGER, sender=STRANGER)


def test_mandates_are_listed_by_delegator():
    w = world()
    registry, _, _ = deploy_stack(w)
    mine_a = register(w, registry)
    mine_b = register(w, registry, mandate_text="Only buy storage.")
    theirs = register(w, registry, delegator=STRANGER)

    mine = json.loads(w.call(registry, "get_mandates_by_delegator", DELEGATOR))
    assert sorted(m["delegation_id"] for m in mine) == sorted([mine_a, mine_b])

    other = json.loads(w.call(registry, "get_mandates_by_delegator", STRANGER))
    assert [m["delegation_id"] for m in other] == [theirs]

    assert len(json.loads(w.call(registry, "get_all_mandates"))) == 3


def test_delegation_ids_are_unique_per_registration():
    w = world()
    registry, _, _ = deploy_stack(w)
    first = register(w, registry)
    second = register(w, registry)
    assert first != second


def test_delegation_ids_carry_the_registry_address():
    """
    A delegation_id must be unique across registry deployments, not just within
    one. The host-chain handle is keccak256 of this string, so a redeployed
    registry that restarted its nonce at zero would mint an id whose handle
    already exists on the host chain -- and openDelegation reverts on that,
    leaving the mandate registered but unenforceable.
    """
    from tests.builders import REGISTRY_ADDR

    w = world()
    registry, _, _ = deploy_stack(w)
    did = register(w, registry)
    assert did.startswith("del_" + REGISTRY_ADDR[2:10] + "_")

    # A fresh registry at a different address mints a different id for the same
    # delegator, agent and nonce.
    from contracts.mandate_registry import MandateRegistry

    other_addr = "0x4444444444444444444444444444444444444444"
    other = MandateRegistry.__new__(MandateRegistry)
    other.mandates = {}
    other.mandate_ids = []
    w.deploy(other, other_addr)
    w.call(other, "__init__")
    other_did = register(w, other)

    assert other_did != did
    assert keccak_hex(other_did) != keccak_hex(did)
