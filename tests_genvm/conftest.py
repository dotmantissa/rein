"""
GenVM direct-mode tests.

These run the contracts in a real local GenVM, which is the only place a
GenVM-level crash can be seen with a stack trace. The hand-written harness in
``tests/`` installs a fake ``genlayer`` module and so cannot see those at all;
that is why this lives in a separate directory rather than under ``tests/``,
where the parent conftest would load first and shadow the real SDK.
"""
