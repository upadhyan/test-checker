# 13 — Adjudication, report and promote

**What to build:** Queued tests can be adjudicated (model or user override) with verdict effects applied; `report` writes md+json; `promote` copies accepted tests into the suite, protects them and updates the verified snapshot, refusing on unresolved verdicts.

**Blocked by:** 07 — Unverified-file tracking: `status`, `scope`, `waive`, 12 — Bundles, emit, ingest: the manual blind loop

**Status:** ready-for-agent

- [ ] `code-wrong` with `spec_basis: none` is downgraded
- [ ] Report sections follow §12 order
- [ ] Promote refuses without `--force` while blocking verdicts exist
