import sys
from unittest.mock import MagicMock
import types

_mod = types.ModuleType("genlayer")
mock_gl = MagicMock()


class MockSender:
    sender_address = "owner_addr"


mock_gl.message = MockSender()
mock_gl.Contract = object


def public_mock(f):
    return f


mock_gl.public = MagicMock()
mock_gl.public.view = public_mock
mock_gl.public.write = public_mock
mock_gl.vm.UserError = ValueError

_mod.gl = mock_gl
_mod.Address = str
_mod.TreeMap = dict
_mod.DynArray = list
_mod.u256 = int
_mod.__all__ = ["gl", "Address", "TreeMap", "DynArray", "u256"]
sys.modules["genlayer"] = _mod


class FakeResponse:
    """
    Stand-in for what gl.nondet.web.get returns.

    The contract reads .status and slices .body as bytes. A plain string has
    neither, so a test that mocks web.get with a string silently exercises the
    no-evidence path instead of the parsing it means to check.
    """

    def __init__(self, body, status=200):
        self.status = status
        self.body = body if isinstance(body, bytes) else str(body).encode()
        self.headers = {}


def judge_leader_only(fn, task=None, criteria=None):
    """
    Stand in for gl.eq_principle.prompt_non_comparative.

    Direct execution runs the leader only, which is what this returns. Validator
    behaviour is not reproducible here and belongs in an integration test.
    """
    return fn()
