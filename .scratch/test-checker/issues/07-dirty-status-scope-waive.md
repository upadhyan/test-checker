# 07 — Unverified-file tracking: `status`, `scope`, `waive`

**What to build:** The engine knows which source files changed since verification. `status` summarises them, `scope` lists changed files with hunks, and `waive` marks files verified without a run.

**Blocked by:** 03 — Config, `init`, ledger and state

**Status:** done

- [ ] Dirty computation follows §10
- [ ] `scope --since` reports hunk ranges
- [ ] `waive` appends a `waived` ledger entry and clears dirtiness
