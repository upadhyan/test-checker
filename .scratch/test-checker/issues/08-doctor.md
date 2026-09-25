# 08 — `doctor` with per-framework templates

**What to build:** `tcheck doctor` proves a config works by running a trivial passing and failing test in a scratch worktree and checking the JUnit result, with templates for common frameworks and a `--use` fallback.

**Blocked by:** 05 — Exec hardening

**Status:** ready-for-agent

- [ ] `doctor` passes on a Python scratch repo using `examples/config.python.yaml`
- [ ] Clear fix hints on failure
- [ ] `--use` accepts agent-written tests
