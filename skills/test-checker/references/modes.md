# Modes

What stands in for "the fixed version" differs by mode. The four-way classification is exact in `bugfix` mode and approximate in the others.

## bugfix

**Use when** you fixed a bug and want tests that would have caught it.

| | Default | Override |
|---|---|---|
| Buggy revision | `HEAD` | `--buggy <rev>` |
| Fixed revision | `WORKTREE` (uncommitted changes) | `--fixed <rev>` |
| Spec derived from | fixed code | `spec.source: buggy` (paper replication and selftest) |

The engine checks out both revisions as `git worktree`s under `.test-checker/worktrees/`. It copies the composed tests into the same relative `test_dir` in each, and runs `commands.run` in each.

| Fixed | Buggy | Label | Meaning | Default action |
|---|---|---|---|---|
| pass | fail | `effective` | catches the bug | promote as a regression test |
| fail | pass | `misguided` | enshrines the buggy behaviour | adjudicate (usually `test-wrong`, or the spec is wrong) |
| pass | pass | `neutral` | valid, doesn't exercise the bug | promote if the user wants coverage |
| fail | fail | `broken` | wrong on both | adjudicate against the fixed version |

Success signal: at least one `effective` test per target, and zero unresolved `misguided`.

## new

**Use when** there's no known-good version: new code, a refactor, or a feature change.

- The spec comes from the current code, via the advanced prompt. Its `<analysis>` block ("logical mistakes", "robustness omissions") is surfaced in the report as **suspicions**. That's a direct bug-finding signal.
- Blind tests run on the current code:
  - **pass:** `accepted`.
  - **fail:** `disputed`, which goes to adjudication. A `code-wrong` verdict is a likely bug.
- **Optional mutation step** (`commands.mutate` set). The engine generates mutants, and each mutant plays the "buggy version":
  - an accepted test that fails on a mutant *kills* it, so it's `effective`;
  - the report gives the kill rate per target.
  - Surviving mutants are listed as coverage gaps, not errors.

## audit

**Use when** checking whether existing tests are trustworthy. This is the default mode: "audit my tests".

1. The agent inventories the unit test files and maps them to the units they call. Each unit becomes a target.
2. The engine runs the existing tests (`--existing <paths>`) and a fresh blind suite on the current code.
3. **Disagreement:** an existing test passes, but a blind test on the same unit fails. That's queued for adjudication with both tests shown.
4. **Outcome:** `code-wrong` means the existing test likely enshrines a bug. The report names it as `suspect-existing`.
5. **Rewrite:** once the code is fixed, the blind test passes and the bad suspects fail. The agent deletes only the suspects that now fail and promotes the target's accepted blind tests in their place. Every other existing test is kept.
6. **Limitation:** "same unit" is known, but "same behaviour" isn't. The adjudicator decides whether the two tests are actually about the same case.

## Choosing scope

In `bugfix` and `new`, default scope is changed units since the last verified snapshot (`tcheck scope`). In `audit`, it is every unit the existing tests call, confirmed with the user first. Each target costs about four model calls, plus up to three repair rounds. Whole-file or whole-module scope should be the user's explicit choice.
