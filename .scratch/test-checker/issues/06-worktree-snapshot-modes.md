# 06 — Working-tree snapshot, `new`/`audit` modes

**What to build:** Users can verify uncommitted work: `--fixed WORKTREE` snapshots without touching the index, worktrees are cached per commit, and classification works for `new` and `audit` modes including mutants and suspect-existing tests.

**Blocked by:** 04 — Tracer: hand-written tests classified on `off_by_one`

**Status:** done

- [ ] Snapshot leaves `git status` and the index unchanged
- [ ] `new` mode labels accepted/disputed
- [ ] `audit` mode queues existing-vs-blind disagreements
