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
