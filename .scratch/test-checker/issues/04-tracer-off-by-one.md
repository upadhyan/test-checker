# 04 — Tracer: hand-written tests classified on `off_by_one`

**What to build:** With the `off_by_one` fixture, a user can start a bugfix run, add the target, drop hand-written tests into a round, compose, exec and classify, and see one test `effective` and one `misguided`.

**Blocked by:** 03 — Config, `init`, ledger and state

**Status:** done

- [ ] `off_by_one` fixture exists per fixtures-spec
- [ ] `run start`, `target add`, `compose`, `exec`, `classify` work for REV revisions
- [ ] Classification matches expectations for the two hand-written tests
- [ ] The user's working tree is untouched
