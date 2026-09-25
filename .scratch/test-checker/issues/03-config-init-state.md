# 03 — Config, `init`, ledger and state

**What to build:** Users can run `tcheck init` to get a config from the closest example, and the engine loads and validates any config against the shipped schema. The ledger and `state.json` are written through one module.

**Blocked by:** 02 — Engine skeleton and `tcheck env`

**Status:** ready-for-agent

- [ ] The YAML parser loads every example config
- [ ] Invalid configs are rejected with exit 2 and a readable path
- [ ] `init` refuses to overwrite without `--force` and writes the inner `.gitignore`
- [ ] Ledger appends are valid JSONL
