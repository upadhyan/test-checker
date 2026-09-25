# 02 — Engine skeleton and `tcheck env`

**What to build:** `npm run build` produces a single zero-dependency `dist/tcheck.mjs`. Global flags (`--json`, `--root`, `--harness`, `--quiet`) and exit codes behave per the contract; repo discovery and harness detection feed `tcheck env`.

**Blocked by:** 01 — Housekeeping and first commit

**Status:** done

- [ ] `node dist/tcheck.mjs env --json` in a scratch git repo prints the §4 shape
- [ ] Unknown command exits with the usage error code
- [ ] Harness precedence honours `--harness`, `TCHECK_HARNESS`, then env signals
