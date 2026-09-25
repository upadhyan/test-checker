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

**Use when** checking whether existing tests are trustworthy.

1. The engine runs the existing tests (`--existing <paths>`) and a fresh blind suite on the current code.
2. **Disagreement:** an existing test passes, but a blind test on the same unit fails. That's queued for adjudication with both tests shown.
3. **Outcome:** `code-wrong` means the existing test likely enshrines a bug. The report names it as `suspect-existing`.
4. **Limitation:** "same unit" is known, but "same behaviour" isn't. The adjudicator decides whether the two tests are actually about the same case.

## Choosing scope

Default scope is changed units since the last verified snapshot (`tcheck scope`). Each target costs about four model calls, plus up to three repair rounds. Whole-file or whole-module scope should be the user's explicit choice.
