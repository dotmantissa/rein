"""
Direct-mode harness for the REIN contracts.

The previous harness was a MagicMock. That is why the bugs this suite now covers
shipped: a mock answers every attribute with another mock, so a contract that
read a mandate from the wrong place, or paid a bond to nobody, or agreed with a
leader it never checked, still passed. Nothing here returns a mock. The pieces
of GenLayer the contracts actually use are implemented:

* ``gl.vm.run_nondet`` runs the leader and then runs the validator against the
  leader's result, so a test exercises the real comparison rule rather than
  skipping it.
* ``gl.eq_principle.strict_eq`` runs the function twice and requires equal
  results, which is what the network does.
* ``gl.get_contract_at`` is backed by a world of deployed instances, so a
  cross-contract read reaches the other contract's real code and an emit arrives
  with the calling contract as its sender.
* ``gl.message.value`` carries a real bond, and ``emit_transfer`` is recorded so
  a payout can be asserted.

Emitted writes are asynchronous on GenLayer and synchronous here. That is the
one deliberate divergence; it is noted on ``_EmitProxy``.
"""

import json
import sys
import types
from dataclasses import dataclass

from Crypto.Hash import keccak as _pycryptodome_keccak


# --------------------------------------------------------------------- keccak


class _Keccak256:
    """keccak256 with the hashlib-shaped interface the GenVM runner exposes."""

    def __init__(self, data: bytes | None = None):
        self._h = _pycryptodome_keccak.new(digest_bits=256)
        if data:
            self._h.update(data)

    def update(self, data: bytes) -> None:
        self._h.update(data)

    def digest(self) -> bytes:
        return self._h.digest()

    def hexdigest(self) -> str:
        return self._h.hexdigest()


# ---------------------------------------------------------------------- world


@dataclass
class FakeResponse:
    """
    Stand-in for what gl.nondet.web.get / .post return.

    The contracts read ``.status`` and slice ``.body`` as bytes. A plain string
    has neither, so a test that hands back a string silently exercises the
    no-evidence path instead of the parsing it means to check.
    """

    body: bytes
    status: int = 200

    def __init__(self, body, status: int = 200):
        self.status = status
        self.body = body if isinstance(body, (bytes, bytearray)) else str(body).encode()
        self.headers = {}


class World:
    """The chain the contracts under test are running on."""

    ZERO = "0x" + "00" * 20

    def __init__(self):
        self.contracts: dict[str, object] = {}
        self.addresses: dict[int, str] = {}
        self.sender = "0x" + "a1" * 20
        self.value = 0
        self.current_contract = self.ZERO
        # Call handlers, set per test.
        self.http = None
        self.prompt = None
        # Observable effects.
        self.emits: list[dict] = []
        self.transfers: list[dict] = []
        self.prompts: list[str] = []
        self.validator_votes: list[bool] = []

    def deploy(self, instance, address: str):
        """Register an already-constructed contract instance at an address."""
        self.contracts[address.lower()] = instance
        self.addresses[id(instance)] = address.lower()
        return instance

    def address_of(self, instance) -> str:
        return self.addresses.get(id(instance), self.ZERO)

    def call(self, instance, method: str, *args, sender=None, value=0, **kwargs):
        """Invoke a contract method with an explicit sender and value."""
        prev = (self.sender, self.value, self.current_contract)
        if sender is not None:
            self.sender = sender
        self.value = int(value)
        self.current_contract = self.address_of(instance)
        try:
            return getattr(instance, method)(*args, **kwargs)
        finally:
            self.sender, self.value, self.current_contract = prev


_WORLD = World()


def reset_world() -> World:
    global _WORLD
    _WORLD = World()
    return _WORLD


def world() -> World:
    return _WORLD


# ------------------------------------------------------------------ fake gl


class _UserError(ValueError):
    """gl.vm.UserError. A ValueError so existing pytest.raises calls still read well."""

    @property
    def message(self) -> str:
        return str(self)


@dataclass
class _Return:
    calldata: object


@dataclass
class _VMError:
    message: str


class _Message:
    @property
    def sender_address(self):
        return _WORLD.sender

    @property
    def contract_address(self):
        return _WORLD.current_contract

    @property
    def origin_address(self):
        return _WORLD.sender

    @property
    def value(self):
        return _WORLD.value

    @property
    def chain_id(self):
        return 61999


class _Web:
    def get(self, url, headers=None):
        if _WORLD.http is None:
            return None
        return _WORLD.http("GET", url, None)

    def post(self, url, body=None, headers=None):
        if _WORLD.http is None:
            return None
        return _WORLD.http("POST", url, body)


class _Nondet:
    def __init__(self):
        self.web = _Web()

    def exec_prompt(self, prompt, response_format=None):
        _WORLD.prompts.append(prompt)
        if _WORLD.prompt is None:
            raise AssertionError("a prompt was issued but no prompt handler is set")
        return _WORLD.prompt(prompt)


class _ViewProxy:
    """Synchronous read of another contract, reaching its real code."""

    def __init__(self, address):
        self._address = address

    def __getattr__(self, name):
        target = _WORLD.contracts.get(self._address)
        if target is None:
            raise _UserError(f"no contract deployed at {self._address}")
        method = getattr(target, name, None)
        if method is None:
            raise _UserError(f"{self._address} has no method {name}")

        def _invoke(*args, **kwargs):
            return _WORLD.call(target, name, *args, **kwargs)

        return _invoke


class _EmitProxy:
    """
    Write to another contract.

    On GenLayer this is queued and runs after the current transaction settles.
    Here it runs immediately, with the emitting contract as the sender, which is
    the part that matters for authorization. A test that needs to observe
    ordering should assert on ``world().emits`` rather than on resulting state.
    """

    def __init__(self, address, value, on):
        self._address = address
        self._value = value
        self._on = on

    def __getattr__(self, name):
        def _invoke(*args, **kwargs):
            _WORLD.emits.append(
                {
                    "to": self._address,
                    "method": name,
                    "args": list(args),
                    "kwargs": dict(kwargs),
                    "value": self._value,
                    "on": self._on,
                    "from": _WORLD.current_contract,
                }
            )
            target = _WORLD.contracts.get(self._address)
            if target is None:
                return None
            return _WORLD.call(
                target, name, *args, sender=_WORLD.current_contract, **kwargs
            )

        return _invoke


class _ContractAt:
    def __init__(self, address):
        self._address = str(address).lower()

    def view(self, state=None):
        return _ViewProxy(self._address)

    def emit(self, value=0, on="finalized"):
        return _EmitProxy(self._address, int(value), on)

    def emit_transfer(self, value, on="finalized"):
        if int(value) <= 0:
            raise ValueError("value must be greater than 0 for emit_transfer")
        _WORLD.transfers.append(
            {
                "to": self._address,
                "value": int(value),
                "on": on,
                "from": _WORLD.current_contract,
            }
        )

    @property
    def balance(self):
        return 0


class _Vm:
    UserError = _UserError
    Return = _Return
    VMError = _VMError

    @staticmethod
    def run_nondet(leader_fn, validator_fn, **kwargs):
        """
        Run the leader, then make the validator check it.

        Direct mode has one node, so this cannot test disagreement between two
        different models. It can and does test that the validator agrees with a
        correct leader, and tests drive disagreement by feeding the validator a
        different answer than the leader got.
        """
        result = leader_fn()
        vote = validator_fn(_Return(result))
        _WORLD.validator_votes.append(bool(vote))
        if not vote:
            raise _UserError("[EXPECTED] validators did not agree with the leader")
        return result

    run_nondet_unsafe = run_nondet

    @staticmethod
    def spawn_sandbox(fn, allow_write_ops=False):
        try:
            return _Return(fn())
        except _UserError as e:
            return e
        except Exception as e:  # pragma: no cover - mirrors VM behaviour
            return _VMError(str(e))

    @staticmethod
    def unpack_result(res):
        if isinstance(res, _UserError):
            raise res
        if isinstance(res, _VMError):
            raise _UserError("vm error: " + res.message)
        return res.calldata


class _EqPrinciple:
    @staticmethod
    def strict_eq(fn):
        """Run twice and require identical results, as the network does."""
        first = fn()
        second = fn()
        if first != second:
            raise _UserError(
                "[EXPECTED] strict equivalence failed: "
                f"{json.dumps(first, sort_keys=True, default=str)} != "
                f"{json.dumps(second, sort_keys=True, default=str)}"
            )
        return first


class _Write:
    def __call__(self, f):
        f.__gl_write__ = True
        return f

    def payable(self, f):
        f.__gl_write__ = True
        f.__gl_payable__ = True
        return f


class _Public:
    write = _Write()

    @staticmethod
    def view(f):
        f.__gl_view__ = True
        return f


class _ContractBase:
    balance = 0


class _Gl:
    Contract = _ContractBase
    message = _Message()
    nondet = _Nondet()
    vm = _Vm()
    eq_principle = _EqPrinciple()
    public = _Public()

    @staticmethod
    def get_contract_at(address):
        return _ContractAt(address)


gl = _Gl()


# ------------------------------------------------------- install fake modules

_genlayer = types.ModuleType("genlayer")
_genlayer.gl = gl
_genlayer.Address = str
_genlayer.TreeMap = dict
_genlayer.DynArray = list
_genlayer.u256 = int
_genlayer.u160 = int
_genlayer.i256 = int
_genlayer.__all__ = ["gl", "Address", "TreeMap", "DynArray", "u256"]

_genlayer_py = types.ModuleType("genlayer.py")
_genlayer_keccak = types.ModuleType("genlayer.py.keccak")
_genlayer_keccak.Keccak256 = _Keccak256
_genlayer_py.keccak = _genlayer_keccak
_genlayer.py = _genlayer_py

sys.modules["genlayer"] = _genlayer
sys.modules["genlayer.py"] = _genlayer_py
sys.modules["genlayer.py.keccak"] = _genlayer_keccak


# ------------------------------------------------------------------ fixtures

import pytest  # noqa: E402  (must follow the module installation above)


@pytest.fixture(autouse=True)
def fresh_world():
    """Every test gets a clean chain."""
    yield reset_world()


def keccak_hex(text: str) -> str:
    h = _Keccak256()
    h.update(text.encode("utf-8"))
    return "0x" + h.digest().hex()
