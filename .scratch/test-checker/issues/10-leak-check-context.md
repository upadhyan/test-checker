# 10 — Leak check and `context set`

**What to build:** Anything shown to blind roles is checked for leakage of the implementation: line test, shingle test, common-line exclusion, and redact mode. `context set` rejects leaky context with exit 2.

**Blocked by:** 04 — Tracer: hand-written tests classified on `off_by_one`

**Status:** done

- [ ] Context containing a body line is rejected
- [ ] Common boilerplate lines do not trigger
- [ ] Shingle threshold is configurable
- [ ] Unit tests cover each rule
