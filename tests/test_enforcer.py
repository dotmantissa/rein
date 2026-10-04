"""
Enforcer: what a revocation is authenticated against, and what it actually does.

Three of the reviewer's points land here.

"Authenticate revocation against the stored court verdict": execute_revocation
used to take the verdict JSON as an argument, so anyone who could call the
contract could write their own breach finding and have an agent's authority
pulled on the strength of it. It now takes a verdict_id and reads the ruling out
of the court.

"Implement the claimed host-chain revocation before marking it revoked,
including recording the resulting transaction": the old contract wrote
status EXECUTED the instant a verdict arrived and left evm_tx_hash as an empty
string nothing ever filled in. A revocation is now PENDING_HOST_REVOCATION until
the Sepolia receipt has been read back, and only then REVOKED.

"Enforce the claimed bond and restoration effects": the bond was a string
argument that nothing collected and nothing paid out. file_appeal is payable,
the escrow is real, and adjudication pays it to the appellant or the watcher.
"""

import json
import pytest

from tests.builders import (
    AGENT,
    DELEGATOR,
    HOST_REGISTRY,
    MANDATE,
    MIN_BOND,
    RELAYER,
    RESTORED_TOPIC,
    REVOKED_TOPIC,
    STRANGER,
    EVM_TX,
    TX,
    blockscout_body,
    combined_handler,
    deploy_stack,
    appeal_prompt,
    explorer_handler,
    host_handler,
    receipt,
    register,
    run_review,
    verdict_prompt,
)
from tests.conftest import keccak_hex, world

WATCHER = "0x7777777777777777777777777777777777777777"


# ------------------------------------------------------------------ scaffolding


def breach_verdict(w, registry, court, severity="HIGH", sender=WATCHER, **kwargs):
    """Produce a real stored breach verdict for the registered delegation."""
    did = register(w, registry, **kwargs)
    w.http = explorer_handler()
    w.prompt = verdict_prompt(severity=severity)
    v = run_review(w, court, did, sender=sender)
    return did, v


def revoked(w, registry, court, enforcer, severity="HIGH"):
    """Carry a delegation all the way to a confirmed host-chain revocation."""
    did, v = breach_verdict(w, registry, court, severity=severity)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    handle = keccak_hex(did)
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(handle=handle), is_active=False),
    )
    rev = json.loads(
        w.call(
            enforcer,
            "confirm_host_revocation",
            rev["revocation_id"],
            EVM_TX,
            sender=RELAYER,
        )
    )
    return did, v, rev


# ---------------------------------------------------- authenticating a verdict


def test_a_verdict_the_court_never_issued_cannot_revoke():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    register(w, registry)

    with pytest.raises(ValueError, match="does not exist in the court of record"):
        w.call(enforcer, "execute_revocation", "vrd_del_whatever_0", sender=RELAYER)


def test_revocation_reads_the_verdict_out_of_the_court():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)

    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )

    assert rev["delegation_id"] == did
    assert rev["verdict_id"] == v["verdict_id"]
    assert rev["severity"] == "HIGH"
    assert rev["breached_clause"] == v["breached_clause"]
    assert rev["agent_address"] == AGENT.lower()
    # Taken from the verdict, not from the caller.
    assert rev["watcher"] == WATCHER.lower()


def test_a_compliant_verdict_cannot_revoke():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler()
    w.prompt = verdict_prompt(verdict="compliant", clause=None, severity="LOW")
    v = run_review(w, court, did)

    with pytest.raises(ValueError, match="Only breach verdicts"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_low_severity_breach_cannot_revoke():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court, severity="LOW")

    with pytest.raises(ValueError, match="Severity too low"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_transaction_the_agent_did_not_send_cannot_revoke():
    """
    A verdict about a transaction the registered agent did not send says nothing
    about this delegation, so it must not be able to end it. The court refuses
    to reach "breach" on an unattributed action in the first place, so this is
    rejected on the verdict enum.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did = register(w, registry)
    w.http = explorer_handler(blockscout_body(sender=STRANGER))
    w.prompt = verdict_prompt()
    v = run_review(w, court, did)

    assert v["attributed"] is False
    with pytest.raises(ValueError, match="Only breach verdicts"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_breach_verdict_without_attribution_is_still_refused():
    """
    Defence in depth for the check above. Should a breach verdict ever be
    recorded without attribution -- a court bug, or an older verdict from
    before attribution existed -- the enforcer refuses it rather than treating a
    missing field as permission.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)

    record = json.loads(court.verdicts[v["verdict_id"]])
    record["attributed"] = False
    court.verdicts[v["verdict_id"]] = json.dumps(record, sort_keys=True)

    with pytest.raises(ValueError, match="not attributed"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_verdict_about_a_since_edited_mandate_cannot_revoke():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)

    record = json.loads(registry.mandates[did])
    record["mandate_text"] = "Do whatever you like."
    record["mandate_hash"] = keccak_hex(record["mandate_text"])
    registry.mandates[did] = json.dumps(record, sort_keys=True)

    with pytest.raises(ValueError, match="mandate has changed"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_verdict_about_a_different_agent_cannot_revoke():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)

    record = json.loads(registry.mandates[did])
    record["agent_address"] = STRANGER.lower()
    registry.mandates[did] = json.dumps(record, sort_keys=True)

    with pytest.raises(ValueError, match="different agent"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_a_delegation_with_no_host_registry_cannot_be_revoked():
    """
    If nothing on a host chain holds the authority, there is nothing to switch
    off, and recording a revocation would be the empty gesture the old contract
    made.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court, host_registry="")

    with pytest.raises(ValueError, match="no host-chain session key registry"):
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)


def test_one_verdict_revokes_once():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court)

    first = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    second = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )

    assert first["revocation_id"] == second["revocation_id"]
    assert w.call(enforcer, "get_revocation_count") == 1


# --------------------------------------------- the host-chain confirmation gate


def test_a_fresh_revocation_is_pending_not_executed():
    """
    The verdict is in, so the mandate is flagged; the authority is not gone
    until the host chain says so, so it is not marked revoked.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)

    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )

    assert rev["status"] == "PENDING_HOST_REVOCATION"
    assert rev["evm_tx_hash"] == ""
    assert rev["host_action"] == "revoke(bytes32,bytes32)"
    assert rev["host_registry"] == HOST_REGISTRY
    assert rev["host_delegation_id"] == keccak_hex(did)
    assert rev["host_verdict_ref"] == keccak_hex(v["verdict_id"])
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "FLAGGED"
    assert w.call(registry, "is_live", did) is True


def test_confirmation_records_the_transaction_and_revokes():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)

    assert rev["status"] == "REVOKED"
    assert rev["evm_tx_hash"] == EVM_TX
    assert rev["evm_block_number"] == "0x7a1200"
    assert rev["confirmed_by"] == RELAYER.lower()
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"
    assert w.call(registry, "is_live", did) is False


def test_a_transaction_to_another_contract_is_not_a_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(to=STRANGER, handle=keccak_hex(did))),
    )

    with pytest.raises(ValueError, match="not sent to this delegation"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )
    assert json.loads(w.call(enforcer, "get_revocation", rev["revocation_id"]))[
        "status"
    ] == "PENDING_HOST_REVOCATION"


def test_a_transaction_for_another_delegation_is_not_this_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(handle=keccak_hex("del_somebody_else_0"))),
    )

    with pytest.raises(ValueError, match="expected event for this delegation"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


def test_the_wrong_event_is_not_a_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(handle=keccak_hex(did), topic=RESTORED_TOPIC)),
    )

    with pytest.raises(ValueError, match="expected event"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


def test_a_reverted_transaction_is_not_a_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(handle=keccak_hex(did), status="0x0")),
    )

    with pytest.raises(ValueError, match="did not succeed"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


def test_a_delegation_the_host_chain_still_reports_as_live_is_not_revoked():
    """
    The event proves a transaction happened. isActive proves the effect stuck.
    Both are required, so a revocation that was immediately undone cannot be
    presented as one that holds.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(
        explorer_handler(),
        host_handler(receipt(handle=keccak_hex(did)), is_active=True),
    )

    with pytest.raises(ValueError, match="reports the delegation as active"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


def test_an_unreachable_host_chain_is_transient_not_a_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(explorer_handler(), host_handler(fail=True))

    with pytest.raises(ValueError, match=r"\[TRANSIENT\]"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


def test_a_missing_receipt_is_not_a_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(explorer_handler(), host_handler(receipt_result=None))

    with pytest.raises(ValueError, match=r"\[TRANSIENT\]"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], EVM_TX,
            sender=RELAYER,
        )


@pytest.mark.parametrize("bad", ["", "0xdeadbeef", "nope"])
def test_a_malformed_evm_hash_is_refused(bad):
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    with pytest.raises(ValueError, match="evm_tx_hash"):
        w.call(
            enforcer, "confirm_host_revocation", rev["revocation_id"], bad,
            sender=RELAYER,
        )


def test_the_legacy_record_method_still_verifies():
    """
    record_evm_revocation used to write whatever hash the owner passed. It now
    runs the same confirmation, because an owner-asserted hash was exactly what
    made the revocation claim unfalsifiable.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )
    w.http = combined_handler(explorer_handler(), host_handler(receipt(to=STRANGER)))

    with pytest.raises(ValueError, match="not sent to this delegation"):
        w.call(enforcer, "record_evm_revocation", rev["revocation_id"], EVM_TX,
               sender=RELAYER)

    with pytest.raises(ValueError, match="owner"):
        w.call(enforcer, "record_evm_revocation", rev["revocation_id"], EVM_TX,
               sender=STRANGER)


# ------------------------------------------------------------- bonded appeals


def test_an_appeal_escrows_a_real_bond():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)

    a = json.loads(
        w.call(
            enforcer, "file_appeal", rev["revocation_id"], "The GPU vendor resells ads.",
            sender=DELEGATOR, value=MIN_BOND * 2,
        )
    )

    assert a["bond_wei"] == str(MIN_BOND * 2)
    assert a["appellant"] == DELEGATOR.lower()
    assert a["on_behalf_of"] == DELEGATOR.lower()
    assert a["watcher"] == WATCHER.lower()
    assert a["status"] == "PENDING"
    assert a["bond_settlement"] == "ESCROWED"


def test_an_appeal_without_a_bond_is_refused():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)

    with pytest.raises(ValueError, match="bond must be at least"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "no bond",
               sender=DELEGATOR, value=0)
    with pytest.raises(ValueError, match="bond must be at least"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "too little",
               sender=DELEGATOR, value=MIN_BOND - 1)


def test_a_stranger_cannot_appeal_someone_elses_revocation():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)

    with pytest.raises(ValueError, match="Only the delegator"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "let me out",
               sender=STRANGER, value=MIN_BOND)


def test_a_revocation_still_awaiting_the_host_chain_cannot_be_appealed():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    _, v = breach_verdict(w, registry, court)
    rev = json.loads(
        w.call(enforcer, "execute_revocation", v["verdict_id"], sender=RELAYER)
    )

    with pytest.raises(ValueError, match="not in a state that can be appealed"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "premature",
               sender=DELEGATOR, value=MIN_BOND)


def test_a_revocation_can_only_be_appealed_once():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    w.call(enforcer, "file_appeal", rev["revocation_id"], "first",
           sender=DELEGATOR, value=MIN_BOND)

    with pytest.raises(ValueError, match="already been appealed"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "second",
               sender=DELEGATOR, value=MIN_BOND)


def test_an_empty_reason_is_refused():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    with pytest.raises(ValueError, match="appeal_reason"):
        w.call(enforcer, "file_appeal", rev["revocation_id"], "   ",
               sender=DELEGATOR, value=MIN_BOND)


# ---------------------------------------------------------------- adjudication


def test_the_appeal_panel_reads_the_verified_action_not_a_retelling():
    """
    The backend used to pass the first judge's own reasoning in as "the action",
    so the appeal re-litigated a summary of the verdict rather than the thing
    the agent did. The panel now gets the registered mandate and the block
    explorer facts the verdict was reached on.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "It was research compute.",
               sender=DELEGATOR, value=MIN_BOND)
    )

    w.prompts.clear()
    w.prompt = appeal_prompt("UPHELD")
    w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)

    prompt = w.prompts[0]
    assert MANDATE in prompt
    assert "37407860000000000000" in prompt  # the fact that decided it
    assert TX in prompt
    assert "It was research compute." in prompt
    assert "advocacy, not evidence" in prompt


def test_an_upheld_appeal_pays_the_bond_to_the_watcher():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "I disagree.",
               sender=DELEGATOR, value=MIN_BOND)
    )
    w.prompt = appeal_prompt("UPHELD")

    out = json.loads(w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER))

    assert out["status"] == "UPHELD"
    assert out["bond_settlement"] == "AWARDED_TO_WATCHER"
    assert out["bond_paid_to"] == WATCHER.lower()
    assert w.transfers == [
        {"to": WATCHER.lower(), "value": MIN_BOND, "on": "finalized",
         "from": w.address_of(enforcer)}
    ]
    # The revocation stands, and the mandate stays revoked.
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"


def test_an_overturned_appeal_returns_the_bond_and_queues_restoration():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "Compute, not ads.",
               sender=DELEGATOR, value=MIN_BOND)
    )
    w.prompt = appeal_prompt("OVERTURNED")

    out = json.loads(w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER))

    assert out["status"] == "OVERTURNED"
    assert out["bond_settlement"] == "RETURNED_TO_APPELLANT"
    assert out["bond_paid_to"] == DELEGATOR.lower()
    assert w.transfers[-1]["to"] == DELEGATOR.lower()
    assert w.transfers[-1]["value"] == MIN_BOND
    assert out["restoration_status"] == "PENDING_HOST_RESTORE"
    # Still revoked on chain: the key does not work again until the host chain
    # has been told, and that has been read back.
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "REVOKED"


def test_restoration_requires_the_host_chain_receipt():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "Compute, not ads.",
               sender=DELEGATOR, value=MIN_BOND)
    )
    w.prompt = appeal_prompt("OVERTURNED")
    w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)

    restore_tx = "0x" + "bb" * 32
    handle = keccak_hex(did)

    # A revocation receipt does not restore anything.
    w.http = host_handler(receipt(tx=restore_tx, handle=handle, topic=REVOKED_TOPIC),
                          is_active=True)
    with pytest.raises(ValueError, match="expected event"):
        w.call(enforcer, "confirm_host_restoration", a["appeal_id"], restore_tx,
               sender=RELAYER)

    # Nor does a restore event while the chain still reports the key as dead.
    w.http = host_handler(receipt(tx=restore_tx, handle=handle, topic=RESTORED_TOPIC),
                          is_active=False)
    with pytest.raises(ValueError, match="reports the delegation as inactive"):
        w.call(enforcer, "confirm_host_restoration", a["appeal_id"], restore_tx,
               sender=RELAYER)

    # The real thing.
    w.http = host_handler(receipt(tx=restore_tx, handle=handle, topic=RESTORED_TOPIC),
                          is_active=True)
    out = json.loads(
        w.call(enforcer, "confirm_host_restoration", a["appeal_id"], restore_tx,
               sender=RELAYER)
    )

    assert out["restoration_status"] == "RESTORED"
    assert out["restoration_tx_hash"] == restore_tx
    assert json.loads(w.call(registry, "get_mandate", did))["status"] == "RESTORED"
    assert w.call(registry, "is_live", did) is True


def test_an_upheld_appeal_cannot_restore():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "I disagree.",
               sender=DELEGATOR, value=MIN_BOND)
    )
    w.prompt = appeal_prompt("UPHELD")
    w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)

    with pytest.raises(ValueError, match="Only an overturned appeal"):
        w.call(enforcer, "confirm_host_restoration", a["appeal_id"], "0x" + "cc" * 32,
               sender=RELAYER)


def test_an_appeal_is_adjudicated_once_and_the_bond_paid_once():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "once",
               sender=DELEGATOR, value=MIN_BOND)
    )
    w.prompt = appeal_prompt("OVERTURNED")
    w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)

    with pytest.raises(ValueError, match="not in PENDING status"):
        w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)
    assert len(w.transfers) == 1


def test_adjudicating_an_unknown_appeal_is_refused():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    with pytest.raises(ValueError, match="Appeal not found"):
        w.call(enforcer, "adjudicate_appeal", "apl_nope", sender=RELAYER)


def test_validators_must_agree_on_overturn_versus_uphold():
    """
    Whether an agent gets its authority back is a binary call, so it is compared
    directly rather than assessed for plausibility.
    """
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)
    a = json.loads(
        w.call(enforcer, "file_appeal", rev["revocation_id"], "split panel",
               sender=DELEGATOR, value=MIN_BOND)
    )
    from tests.builders import drifting_prompt

    w.prompt = drifting_prompt(
        [
            {"status": "OVERTURNED", "reasoning": "within spirit"},
            {"status": "UPHELD", "reasoning": "plainly an ad buy"},
        ]
    )

    with pytest.raises(ValueError, match="did not agree"):
        w.call(enforcer, "adjudicate_appeal", a["appeal_id"], sender=RELAYER)
    assert json.loads(w.call(enforcer, "get_appeal", a["appeal_id"]))["status"] == "PENDING"
    assert w.transfers == []


def test_views_report_the_record():
    w = world()
    registry, court, enforcer = deploy_stack(w)
    did, v, rev = revoked(w, registry, court, enforcer)

    assert json.loads(w.call(enforcer, "get_revocation_by_verdict", v["verdict_id"]))[
        "revocation_id"
    ] == rev["revocation_id"]
    assert len(json.loads(w.call(enforcer, "get_revocations_by_delegation", did))) == 1
    assert len(json.loads(w.call(enforcer, "get_all_revocations"))) == 1
    assert w.call(enforcer, "get_appeal_count") == 0
    with pytest.raises(ValueError, match="not found"):
        w.call(enforcer, "get_revocation", "rev_nope")
    with pytest.raises(ValueError, match="not found"):
        w.call(enforcer, "get_appeal", "apl_nope")
