"""
Scenario builders for the REIN contract tests.

Everything here constructs the same shape the deployed system has: a registry
holding a mandate, a court wired to that registry, an enforcer wired to both,
and a host-chain session-key registry the enforcer checks revocations against.
Tests that need a different shape build it from these pieces rather than
stubbing a contract out, because a stub is how the binding bugs stayed hidden.
"""

import json

from tests.conftest import FakeResponse, keccak_hex

# Addresses. The host registry is the ReinSessionKeyRegistry actually deployed
# on Ethereum Sepolia, so the handles in these tests are the real ones.
DELEGATOR = "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"
AGENT = "0xa6e74c0e11a3b8d4e1f2c5a7b9d0e3f4a5b6c7d8"
SESSION_KEY = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"
HOST_REGISTRY = "0xd20055953d51efb3612cac51cfe1d6c29fd592d5"
STRANGER = "0x9999999999999999999999999999999999999999"
RELAYER = "0x" + "a1" * 20  # World.sender default, and the deploying owner

REGISTRY_ADDR = "0x1111111111111111111111111111111111111111"
COURT_ADDR = "0x2222222222222222222222222222222222222222"
ENFORCER_ADDR = "0x3333333333333333333333333333333333333333"

CHAIN = "11155111"
TX = "0xb740caf4efcbf64e9c39b403b4ea1b6974e721969a893a994b95ad1038c140f3"
EVM_TX = "0xac01fd36880adcde3ca34783eacab35840981cd0c56c0b75a77568cfe00b5b87"

MANDATE = (
    "Buy compute for my research. Never pay for advertising of any kind. "
    "Never move more than 1 ETH in a single transaction. "
    "Never grant an unlimited token allowance."
)

REVOKED_TOPIC = keccak_hex("DelegationRevoked(bytes32,bytes32,address)")
RESTORED_TOPIC = keccak_hex("DelegationRestored(bytes32,bytes32,address)")
MIN_BOND = 10**16


def deploy_stack(world):
    """Deploy and wire registry, court and enforcer, as the deploy script does."""
    from contracts.enforcer import Enforcer
    from contracts.mandate_registry import MandateRegistry
    from contracts.rein_court import ReinCourt

    world.sender = RELAYER

    registry = MandateRegistry.__new__(MandateRegistry)
    registry.mandates = {}
    registry.mandate_ids = []
    world.deploy(registry, REGISTRY_ADDR)
    world.call(registry, "__init__")

    court = ReinCourt.__new__(ReinCourt)
    court.verdicts = {}
    court.verdict_ids = []
    court.judged = {}
    world.deploy(court, COURT_ADDR)
    world.call(court, "__init__", REGISTRY_ADDR)

    enforcer = Enforcer.__new__(Enforcer)
    enforcer.revocations = {}
    enforcer.revocation_ids = []
    enforcer.revoked_verdicts = {}
    enforcer.appeals = {}
    enforcer.appeal_ids = []
    world.deploy(enforcer, ENFORCER_ADDR)
    world.call(enforcer, "__init__", COURT_ADDR, REGISTRY_ADDR)

    world.call(registry, "set_court", COURT_ADDR, sender=RELAYER)
    world.call(registry, "set_enforcer", ENFORCER_ADDR, sender=RELAYER)

    return registry, court, enforcer


def register(
    world,
    registry,
    mandate_text=MANDATE,
    delegator=DELEGATOR,
    agent=AGENT,
    ceiling="1000000000000000000",
    chain=CHAIN,
    session_key=SESSION_KEY,
    host_registry=HOST_REGISTRY,
    sender=RELAYER,
):
    return world.call(
        registry,
        "register_mandate",
        delegator,
        agent,
        mandate_text,
        ceiling,
        chain,
        session_key,
        host_registry,
        sender=sender,
    )


# ----------------------------------------------------------------- explorer


def blockscout_body(
    tx=TX,
    sender=AGENT,
    to="0xb6e0edaefc86338a9ed27f794624096e4a341ed7",
    value="37407860000000000000",
    method=None,
    decoded=None,
    confirmations=12,
):
    """A trimmed eth.blockscout.com transaction response."""
    body = {
        "hash": tx,
        "from": {"hash": sender, "is_contract": False},
        "to": {"hash": to, "is_contract": False},
        "value": value,
        "gas_used": "21000",
        "status": "ok",
        "method": method,
        "raw_input": "0x",
        "confirmations": confirmations,
        "timestamp": "2026-09-30T01:00:00.000000Z",
    }
    if decoded:
        body["decoded_input"] = decoded
    return json.dumps(body)


def explorer_handler(body=None, status=200):
    """Answer any explorer GET with one response."""
    payload = blockscout_body() if body is None else body

    def _handler(method, url, request_body):
        if method == "GET":
            return FakeResponse(payload, status=status)
        return None

    return _handler


# ---------------------------------------------------------------- host chain


def receipt(
    tx=EVM_TX,
    to=HOST_REGISTRY,
    handle=None,
    topic=None,
    status="0x1",
    block="0x7a1200",
    logs=None,
):
    """A host-chain eth_getTransactionReceipt result."""
    if logs is None:
        logs = [
            {
                "address": to,
                "topics": [topic or REVOKED_TOPIC, handle or ("0x" + "00" * 32)],
                "data": "0x",
                "blockNumber": block,
                "logIndex": "0x2",
                "transactionHash": tx,
            }
        ]
    return {
        "transactionHash": tx,
        "to": to,
        "status": status,
        "blockNumber": block,
        "logs": logs,
    }


def host_handler(receipt_result=None, is_active=False, fail=False):
    """
    Answer the enforcer's two RPC calls.

    ``is_active`` is what ``isActive(bytes32)`` returns, as the enforcer will
    refuse a revocation the host chain still reports as live.
    """
    word = (
        "0x0000000000000000000000000000000000000000000000000000000000000001"
        if is_active
        else "0x0000000000000000000000000000000000000000000000000000000000000000"
    )

    def _handler(method, url, request_body):
        if method != "POST":
            return None
        if fail:
            return FakeResponse("{}", status=503)
        req = json.loads(request_body)
        if req.get("method") == "eth_getTransactionReceipt":
            return FakeResponse(
                json.dumps({"jsonrpc": "2.0", "id": 1, "result": receipt_result})
            )
        if req.get("method") == "eth_call":
            return FakeResponse(json.dumps({"jsonrpc": "2.0", "id": 2, "result": word}))
        return None

    return _handler


def combined_handler(explorer, host):
    """Serve explorer GETs and host-chain POSTs from one handler."""

    def _handler(method, url, request_body):
        if method == "GET":
            return explorer(method, url, request_body)
        return host(method, url, request_body)

    return _handler


# -------------------------------------------------------------------- judges


def verdict_prompt(
    verdict="breach",
    severity="HIGH",
    clause="Never move more than 1 ETH in a single transaction",
    reasoning="The transaction moved 37.4 ETH.",
    confidence=0.95,
):
    """A compliance judge that always answers the same way."""

    def _handler(prompt):
        return {
            "verdict": verdict,
            "severity": severity,
            "breached_clause": clause,
            "reasoning": reasoning,
            "confidence": confidence,
        }

    return _handler


def appeal_prompt(status="UPHELD", reasoning="The facts violate the quoted clause."):
    def _handler(prompt):
        return {"status": status, "reasoning": reasoning}

    return _handler


def drifting_prompt(answers):
    """
    A judge whose answer changes between calls.

    The leader gets the first answer and the validator the next, which is how a
    test drives genuine disagreement through the comparison rule.
    """
    seq = list(answers)
    state = {"i": 0}

    def _handler(prompt):
        i = min(state["i"], len(seq) - 1)
        state["i"] += 1
        return seq[i]

    return _handler


def run_review(world, court, delegation_id, tx=TX, description="", sender=RELAYER):
    return json.loads(
        world.call(
            court, "review_action", delegation_id, tx, description, sender=sender
        )
    )
