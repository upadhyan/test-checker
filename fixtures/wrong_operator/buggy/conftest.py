"""Per-test timeout without plugins: a hanging test errors on its own instead of killing the whole run."""
import signal

import pytest

TIMEOUT_SECONDS = 10


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    if not hasattr(signal, "SIGALRM"):  # Windows: fall back to the engine's per-command timeout
        yield
        return

    def _expired(signum, frame):
        raise TimeoutError(f"test exceeded {TIMEOUT_SECONDS}s")

    previous = signal.signal(signal.SIGALRM, _expired)
    signal.alarm(TIMEOUT_SECONDS)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
