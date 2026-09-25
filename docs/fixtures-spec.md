# Selftest Fixtures

Small bug/fix pairs for sanity-checking the loop end to end. These aren't a benchmark. The first batch is Python, because it's quick to write. The engine must not special-case Python: fixtures go through the same config-driven path as any repo.

## Layout

```
fixtures/<name>/
├── fixture.yaml       # metadata (below)
├── config.yaml        # a normal .test-checker/config.yaml
├── context.json       # the context an agent would write for the target (bundle.schema.json `context`)
├── buggy/             # full tree at the buggy revision
└── fixed/             # full tree at the fixed revision (identical except the fix)
```

**`fixture.yaml`:**

```yaml
name: off_by_one
language: python
target: "src/fx/stats.py::sum_to"
lines: [3, 9]               # body range in the SPEC-SOURCE tree (buggy, for selftest)
bug: "range(n) instead of range(n + 1): sum_to(n) omits n"
intent: "sum_to(n) returns 1 + 2 + … + n; 0 for n == 0; ValueError for n < 0"
expect:
  min_effective_blind: 1    # the blind run should catch it
```

Keep each fixture to a single module with one or two functions, no dependencies beyond the test runner, and a `config.yaml` using `python -m pytest`.

## Cases (batch 1: Python)

| Name | Target | Bug (buggy → fixed) | Why it's a good misguidance probe |
|---|---|---|---|
| `off_by_one` | `sum_to(n)` | `range(n)` → `range(n + 1)` | Code-aware tests tend to assert `sum_to(3) == 3` (the buggy value) |
| `boundary` | `in_range(x, lo, hi)` (inclusive range) | `lo <= x < hi` → `lo <= x <= hi` | Code-aware tests copy the buggy edge: `in_range(5, 1, 5) is False` |
| `null_guard` | `normalize_name(s)` | missing `None` / empty check: the fixed version raises `ValueError`, the buggy one crashes with `AttributeError` | A robustness omission the advanced prompt should flag |
| `wrong_operator` | `is_valid_port(p)` | `p > 0 or p < 65536` → `p > 0 and p < 65536` | The buggy version returns True for everything, and code-aware tests happily assert that |
| `stale_state` | `Counter.reset()` (with `add(x)` / `total()` as siblings) | `reset()` doesn't clear `_seen` → it does | Stateful; checks that the context bundle (fields, constructor, sibling methods) is enough |

## Pass criteria for `tcheck selftest`

Per fixture:

1. The pipeline completes: spec → bundle → blind → compose → exec → classify → report, with no engine error.
2. The blind run produces ≥ `expect.min_effective_blind` effective tests.

Across the batch:

3. Blind misguided total < baseline misguided total. (The paper's direction; a small sample, so this is a smoke signal, not proof.)
4. No bundle or payload contained any significant body line. Assert this by re-running the leak check over every frozen file.

A failure of criterion 3 is a warning, not a hard fail, because model variance on 5 cases is large. Criteria 1, 2 and 4 are hard fails.

## Batch 2 (later)

Add one non-Python fixture, for example a TypeScript + vitest `boundary` clone. It confirms the config-driven path, JUnit parsing from another runner, and the `compile` step.
