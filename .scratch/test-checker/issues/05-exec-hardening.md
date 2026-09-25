# 05 — Exec hardening

**What to build:** Execution behaves on real-world runners: flaky tests are detected by reruns, timeouts kill the process tree, JUnit may be a file or a directory, a compile step runs, and only repairable errors (redacted) are surfaced for repair.

**Blocked by:** 04 — Tracer: hand-written tests classified on `off_by_one`

**Status:** done

- [ ] A flaky test is excluded and listed
- [ ] A hanging run is killed and missing tests become `error: timeout`
- [ ] Repairable-error extraction never includes `<failure>` text
- [ ] Redaction strips assertion-looking lines and body lines
