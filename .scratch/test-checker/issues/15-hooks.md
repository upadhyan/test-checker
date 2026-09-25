# 15 — Hooks with Claude Code output

**What to build:** `tcheck hook <event>` implements session-start, handoff-guard, protect-tests and stop-gate with Claude Code output, a fast no-config path and fail-open behaviour (handoff-guard fails closed). `evaluateHook` is exported.

**Blocked by:** 07 — Unverified-file tracking: `status`, `scope`, `waive`, 12 — Bundles, emit, ingest: the manual blind loop, 13 — Adjudication, report and promote

**Status:** done

- [ ] No-config fast path exits immediately
- [ ] Handoff guard denies a hand-edited payload
- [ ] protect-tests denies editing generated/protected tests
