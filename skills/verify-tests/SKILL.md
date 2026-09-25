---
name: verify-tests
description: Generate and verify unit tests so they catch bugs instead of enshrining them. Tests are written blind from a spec, then run against buggy and fixed code. Use after fixing a bug, when writing tests for new or changed code, when asked to "verify", "check" or "trust" tests, or when test-checker's stop gate asks for it.
license: MIT
metadata:
  version: "0.1.0"
  paper: "arXiv:2607.22883"
---

# verify-tests

You orchestrate test-checker's verification loop. The deterministic work is done by the `tcheck` engine. The model work is done by isolated roles that receive **payloads** the engine renders.

The engine is `node <plugin-root>/dist/tcheck.mjs`, written `tcheck` below. Step 0 prints the exact command for this harness.

## Non-negotiable rules

1. **Never write or paraphrase a blind role's prompt yourself.** The blind writer and repair roles get exactly the text `tcheck bundle emit` prints, nothing added or removed. You have seen the implementation, so anything you add can leak it.
2. **Never edit generated or verified tests to make them pass.** A failing blind test goes to adjudication. Only a `test-wrong` verdict, or the user, allows changing it. Hooks enforce this where the harness supports hooks.
3. **Never feed assertion failures or runtime values into repair.** The engine filters errors, so pass along only what `tcheck` gives you.
4. **The spec is the reference, not the code.** If the spec is wrong, fix the spec (`tcheck spec edit`) and regenerate. Don't patch tests around it.
5. **Ask the user** when adjudication returns `spec-ambiguous`. Never pick a side yourself.

## Step 0: Environment (once per session)

```
tcheck env --json
```

This reports the harness, the engine command, whether `.test-checker/config.yaml` exists, and `harness_reference`. **Read that reference file now** (`references/harness/<harness>.md`). It says how to run the spec, blind-writer, repair and adjudicator roles in this harness. The steps below say *which* role to run; the reference says *how*.

If there is no config, run the `test-checker-setup` skill first, or follow `references/config-reference.md`.

## Step 1: Pick mode and targets

| Situation | Mode | Command |
|---|---|---|
| You just fixed a bug (fix uncommitted, or you know the before/after revs) | `bugfix` | `tcheck run start --mode bugfix --buggy <rev> --fixed <rev\|WORKTREE>` (defaults: `HEAD` → `WORKTREE`) |
| New or changed code, no known-good version | `new` | `tcheck run start --mode new` |
| Checking whether existing tests are trustworthy | `audit` | `tcheck run start --mode audit --existing <test paths>` |

`tcheck scope --json` lists changed files and hunks since the last verified state. Map them to the functions or methods that changed. Register each one:

```
tcheck target add <run> <file>::<symbol> --lines <start>-<end> [--rev <rev>]
```

`--lines` is the body's line range. The engine uses it to stop the body leaking into blind payloads, so get it right. Keep scope tight: changed units only, unless the user asks for more. See `references/modes.md` for mode details.

## Step 2: Context

For each target, write a context file matching `references/bundle.schema.json` (the `context` part only): signature, constructors of the enclosing type, fields, sibling signatures, and constructors of user-defined parameter and return types. **Signatures only, no bodies.** Also include a short example test from the project if one exists.

```
tcheck context set <run> <target> --file <context.json>
```

The engine rejects context containing lines from the target body.

## Step 3: Spec

```
tcheck spec prompt <run> <target>        # prints a payload
```

Run the **spec-extractor** role with that payload (see the harness reference). It saves its result through `save_spec`, or in harnesses without that tool, via `tcheck spec save <run> <target> --from <file>`. Then show the user the spec:

```
tcheck spec show <run> <target>
```

In `bugfix` mode, if the user described the intended behaviour, pass it with `tcheck spec prompt … --intent "<text>"`. If the spec is wrong, fix it with `tcheck spec edit` before continuing.

## Step 4: Bundle, then blind generation

```
tcheck bundle build <run> <target>       # validates for leaks, freezes, prints bundle id
tcheck bundle emit <bundle-id> --role writer
```

Run the **blind-writer** role with the emitted payload **verbatim**. The tests come back through `submit_tests`, or via `tcheck ingest` for text-returning harnesses.

## Step 5: Compose, run, repair

```
tcheck compose <run>
tcheck exec <run>                        # runs on every revision the mode needs, with flake reruns
```

If `tcheck exec` reports `needs_repair`:

```
tcheck bundle emit <bundle-id> --role repair --run <run>
```

Run the **repair** role with that payload verbatim, then `compose` and `exec` again. Stop after `refine_rounds` rounds (default 3). Tests still broken after that are dropped and listed in the report.

## Step 6: Classify and adjudicate

```
tcheck classify <run>
tcheck adjudicate queue <run> --json
```

For each queued test:

```
tcheck adjudicate prompt <run> <test-id>
```

Run the **adjudicator** role with that payload. The verdict is saved through `save_verdict`, or via `tcheck adjudicate save`.

- `code-wrong`: tell the user it's a likely bug, with the spec line. Fix the **code**, not the test. Then re-run `tcheck exec <run>`.
- `test-wrong`: the engine quarantines the test. Deleting or rewriting it is now allowed.
- `spec-ambiguous`: ask the user which behaviour is intended. Record the answer with `tcheck spec edit` or `tcheck adjudicate override`, then regenerate or re-run.

## Step 7: Report and promote

```
tcheck report <run>                      # writes .test-checker/reports/<run>.md and prints a summary
tcheck promote <run>                     # copies accepted tests into the project's test suite
```

Give the user the summary:

- counts by category;
- likely bugs found;
- tests dropped;
- open questions.

Offer to promote. `promote` also marks the changed files as verified, which clears the stop gate.

## When things go wrong

| Symptom | Do this |
|---|---|
| The harness refuses to launch a blind role | The engine or its tool isn't loaded. Run `tcheck env`, check `node` is on PATH, and follow the fallback in the harness reference. Do not fall back to writing tests yourself. |
| The handoff hook blocked a launch | You changed the payload. Re-emit and pass it verbatim. |
| All tests fail on both revisions | Likely setup or config (`commands.run`, `test_dir`). Run `tcheck doctor`. |
| The stop gate blocks you | Finish this loop, or ask the user whether to `tcheck waive <path> --reason "…"`. |
