# 12 — Bundles, emit, ingest: the manual blind loop

**What to build:** A user can freeze a bundle, emit a writer or repair payload, paste a model's answer into `ingest`, and have it flow through compose/exec/classify. Writer/repair payloads are single-use.

**Blocked by:** 05 — Exec hardening, 11 — Template renderer, payloads and spec commands

**Status:** done

- [ ] A consumed payload cannot be reused
- [ ] A repair payload never contains `<failure>` text or body lines
- [ ] Ingest parses `FILE:` + fenced blocks and `NOTES:`
