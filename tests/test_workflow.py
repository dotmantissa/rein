"""
The whole workflow, in order, with the state asserted at every step.

The reviewer asked for a coherent functional workflow. This is it, written as
the system actually runs: register, act, review, revoke, prove the host chain
stopped the key, appeal with a real bond, re-decide on the verified action, and
either pay the watcher or return the bond and restore the delegation once the
host chain has been told.

Each step only takes inputs the previous step produced. Nothing is asserted on
the strength of an argument a caller supplied.
"""

import json
import pytest

from tests.builders import (
    AGENT,
    DELEGATOR,
    EVM_TX,
    HOST_REGISTRY,
    MANDATE,
    MIN_BOND,
    RELAYER,
    RESTORED_TOPIC,
    TX,
    appeal_prompt,
    blockscout_body,
    combined_handler,
    deploy_stack,
    explorer_handler,
    host_handler,
    receipt,
    register,
    run_review,
    verdict_prompt,
)
from tests.conftest import keccak_hex, world

WATCHER = "0x7777777777777777777777777777777777777777"
RESTORE_TX = "0x" + "be" * 32

AD_SPEND = blockscout_body(
    sender=AGENT,
    to="0xadadadadadadadadadadadadadadadadadadadad",
    value="2500000000000000000",
    method="transfer",
)


def test_breach_to_revocation_with_the_bond_awarded_to_the_watcher():
    w = world()
    registry, court, enforcer = deploy_stack(w)

    # 1. The operator registers a mandate. The host-chain handle is derived, not
    #    supplied, so both chains agree on which delegation this is.
    did = register(w, registry)
    mandate = json.loads(w.call(registry, "get_mandate", did))
    handle = keccak_hex(did)
    assert mandate["status"] == "ACTIVE"
    assert mandate["host_delegation_id"] == handle
    assert mandate["host_registry"] == HOST_REGISTRY

    # 2. A watcher submits one of the agent's transactions for review. They name
    #    a delegation and a hash; the mandate, agent and chain come from the
    #    registry.
    w.http = explorer_handler(AD_SPEND)
    w.prompt = verdict_prompt(
        verdict="breach",
        severity="HIGH",
        clause="Never pay for advertising of any kind",
        reasoning="2.5 ETH was sent to an advertising contract.",
        confidence=0.94,
    )
    verdict = run_review(w, court, did, description="Bought GPU credits", sender=WATCHER)

    assert verdict["verdict"] == "breach"
    assert verdict["attributed"] is True
    assert verdict["agent_address"] == AGENT.lower()
    assert verdict["mandate_hash"] == keccak_hex(MANDATE)
    assert verdict["submitted_by"] == WATCHER.lower()
    assert w.validator_votes == [True]
    # The judge saw the registered mandate, not the submitter's story.
    assert MANDATE in w.prompts[0]

    # 3. The enforcer acts on the stored verdict by id. The mandate is flagged,
    #    but the authority is not gone yet and the record says so.
    rev = json.loads(
        w.call(enforcer, "execute_revocation", verdict["verdict_id"], sender=RELAYER)
    )
    assert rev["status"] == "PENDING_HOST_REVOCATION"
    assert rev["watcher"] == WATCHER.lower()
    assert rev["host_verdict_ref"] == keccak_hex(verdict["verdict_id"])
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "FLAGGED"
    assert w.call(registry, "is_live", did) is True

    # 4. The relayer submits revoke(bytes32,bytes32) on the host chain, and the
    #    enforcer reads the receipt back before marking anything revoked.
    w.http = combined_handler(
        explorer_handler(AD_SPEND),
        host_handler(receipt(handle=handle), is_active=False),
    )
    rev = json.loads(
        w.call(enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
               sender=RELAYER)
    )
    assert rev["status"] == "REVOKED"
    assert rev["evm_tx_hash"] == EVM_TX
    assert rev["evm_block_number"]
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"
    assert w.call(registry, "is_live", did) is False

    # 5. The operator appeals, posting a real bond with the call.
    appeal = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"],
               "The vendor is a compute marketplace, not an ad network.",
               sender=DELEGATOR, value=MIN_BOND)
    )
    assert appeal["bond_wei"] == str(MIN_BOND)
    assert appeal["status"] == "PENDING"

    # 6. A fresh panel re-reads the registered mandate and the verified facts.
    w.prompts.clear()
    w.prompt = appeal_prompt("UPHELD", "The recipient is an advertising contract.")
    decided = json.loads(
        w.call(enforcer, "adjudicate_appeal", appeal["appeal_id"], sender=RELAYER)
    )
    assert "2500000000000000000" in w.prompts[0]
    assert MANDATE in w.prompts[0]

    # 7. Upheld, so the bond goes to the watcher and the revocation stands.
    assert decided["status"] == "UPHELD"
    assert decided["bond_settlement"] == "AWARDED_TO_WATCHER"
    assert w.transfers == [
        {"to": WATCHER.lower(), "value": MIN_BOND, "on": "finalized",
         "from": w.address_of(enforcer)}
    ]
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"

    # 8. And nothing can review that delegation again: its authority is gone.
    with pytest.raises(ValueError, match="already revoked"):
        run_review(w, court, did, tx="0x" + "12" * 32)


def test_breach_to_overturned_appeal_with_the_delegation_restored():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did = register(w, registry)
    handle = keccak_hex(did)

    w.http = explorer_handler(AD_SPEND)
    w.prompt = verdict_prompt(
        verdict="breach",
        severity="MED",
        clause="Never pay for advertising of any kind",
        reasoning="The recipient looks like an ad platform.",
        confidence=0.6,
    )
    verdict = run_review(w, court, did, sender=WATCHER)

    rev = json.loads(
        w.call(enforcer, "execute_revocation", verdict["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(AD_SPEND), host_handler(receipt(handle=handle))
    )
    rev = json.loads(
        w.call(enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
               sender=RELAYER)
    )
    assert rev["status"] == "REVOKED"

    appeal = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"],
               "That contract resells H100 time; the court mistook the counterparty.",
               sender=DELEGATOR, value=MIN_BOND * 3)
    )

    w.prompt = appeal_prompt("OVERTURNED", "The counterparty is a compute reseller.")
    decided = json.loads(
        w.call(enforcer, "adjudicate_appeal", appeal["appeal_id"], sender=RELAYER)
    )

    # The bond comes back to whoever paid it, and the delegation is queued for
    # restoration rather than treated as already restored.
    assert decided["status"] == "OVERTURNED"
    assert decided["bond_settlement"] == "RETURNED_TO_APPELLANT"
    assert w.transfers[-1] == {
        "to": DELEGATOR.lower(), "value": MIN_BOND * 3, "on": "finalized",
        "from": w.address_of(enforcer),
    }
    assert decided["restoration_status"] == "PENDING_HOST_RESTORE"
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"

    # Only the host chain restore makes the key work again.
    w.http = host_handler(
        receipt(tx=RESTORE_TX, handle=handle, topic=RESTORED_TOPIC), is_active=True
    )
    restored = json.loads(
        w.call(enforcer, "confirm_host_restoration", appeal["appeal_id"], RESTORE_TX,
               sender=RELAYER)
    )

    assert restored["restoration_status"] == "RESTORED"
    assert restored["restoration_tx_hash"] == RESTORE_TX
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "RESTORED"
    assert w.call(registry, "is_live", did) is True

    # A restored delegation can be reviewed again, and judged compliant.
    next_tx = "0x" + "34" * 32
    w.http = explorer_handler(
        blockscout_body(tx=next_tx, sender=AGENT, value="100000000000000000")
    )
    w.prompt = verdict_prompt(verdict="compliant", severity="LOW", clause=None,
                              reasoning="Within the ceiling and on-mandate.")
    again = run_review(w, court, did, tx=next_tx, sender=WATCHER)
    assert again["verdict"] == "compliant"
    assert json.loads(w.call(registry, "get_mandate", did))["action_count"] == 2


def test_a_compliant_run_leaves_the_delegation_untouched():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did = register(w, registry)

    w.http = explorer_handler(blockscout_body(sender=AGENT, value="250000000000000000"))
    w.prompt = verdict_prompt(verdict="compliant", severity="LOW", clause=None,
                              reasoning="Research compute, under the ceiling.")
    verdict = run_review(w, court, did, sender=WATCHER)

    assert verdict["verdict"] == "compliant"
    assert verdict["breached_clause"] is None
    with pytest.raises(ValueError, match="Only breach verdicts"):
        w.call(enforcer, "execute_revocation", verdict["verdict_id"], sender=RELAYER)
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "ACTIVE"
    assert w.call(enforcer, "get_revocation_count") == 0


def test_a_revocation_the_host_chain_never_confirmed_never_takes_effect():
    """
    The failure mode the reviewer caught. A verdict alone used to be enough to
    write status EXECUTED and report the delegation as revoked. Now an
    unconfirmed revocation leaves the mandate merely flagged, and the record
    says plainly that it is still waiting.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did = register(w, registry)

    w.http = explorer_handler(AD_SPEND)
    w.prompt = verdict_prompt(clause="Never pay for advertising of any kind")
    verdict = run_review(w, court, did, sender=WATCHER)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", verdict["verdict_id"], sender=RELAYER)
    )

    # The host chain is unreachable, so nothing can be confirmed.
    w.http = combined_handler(explorer_handler(AD_SPEND), host_handler(fail=True))
    with pytest.raises(ValueError, match=r"\[TRANSIENT\]"):
        w.call(enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
               sender=RELAYER)

    stored = json.loads(w.call(enforcer, "get_revocation", rev["revocation_id"]))
    assert stored["status"] == "PENDING_HOST_REVOCATION"
    assert stored["evm_tx_hash"] == ""
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "FLAGGED"

    # And it cannot be appealed, because there is nothing yet to appeal.
    with pytest.raises(ValueError, match="not in a state that can be appealed"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "too soon",
               sender=DELEGATOR, value=MIN_BOND)
