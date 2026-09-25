# Running the roles in any other harness

Use this when `tcheck env` reports `harness: unknown`. There are no hooks, so enforcement relies on you following the rules in SKILL.md.

| Role | How |
|---|---|
| spec-extractor | In-session. Print `tcheck spec prompt …`, answer it, then `tcheck spec save … --from <file>`. |
| blind-writer | `tcheck blind-run <bundle-id> --role writer`. The backend comes from `blind.backend` in config. By default it's the first installed harness CLI (`claude`, `codex`, `opencode`, `pi`), running on the user's subscription. `api` is opt-in, for users with a key. |
| repair | `tcheck blind-run <bundle-id> --role repair --run <run>` |
| adjudicator | In-session. Print `tcheck adjudicate prompt …`, answer it, then `tcheck adjudicate save … --from <file>`. |

If no backend is available, stop and tell the user. Writing the blind tests yourself defeats the method, because you have seen the code.
