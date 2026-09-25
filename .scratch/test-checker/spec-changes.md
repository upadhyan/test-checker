# Spec changes to fold into docs/engine-spec.md

- §3/§8.1: worktrees live only in `worktrees/_cache/<sha>` (mutants: `_cache/<sha>-mutant`); a run maps labels to them. Cached worktrees are reset (composed files removed, `git checkout -- .`) before reuse and are not removed on report.
- §3: `exec/<n>/…` is numbered by exec invocation, not repair round.
- §6: common lines = top 200 lines that occur in ≥ 2 source files. Comment/docstring lines in the body are not significant. Signature = leading decorators/comments + declaration until brackets balance (+ lone `{`).
- §8.3: a file with no testcases after a failed command is a load error unless another file's repairable testcase error explains the abort.
- §8.5: tests whose errors-revision outcome is a repairable error are `unrepairable` (dropped, not queued). Missing outcome after timeout reported as `timeout`.
- §10: ledger type `initialized` (from `init`).
- package.json: test script is `node --test tests/*.test.js` (Node 22+ treats a bare directory as a module).
- fixtures-spec: fixtures carry context.json (selftest has no agent to write context); stale_state targets Counter.reset (the bug's home).
