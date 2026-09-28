# test-checker

An agent plugin that audits your unit tests so they **catch bugs instead of enshrining them**.

When an LLM writes tests while looking at buggy code, it tends to write tests that pass on the bug. test-checker applies the fix from [Zhao, Zhou & Cohen (2026)](https://arxiv.org/abs/2607.22883):

1. **Spec first:** derive what each unit is *meant* to do.
2. **Blind generation:** write tests from that spec without showing the implementation.
3. **Dual execution:** run them on the buggy and fixed versions and classify each test as effective, misguided, neutral or broken.
4. **Adjudicate:** decide whether the test or the code is wrong, and ask you when the spec is ambiguous.

It works with Claude Code, Cowork, Codex, OpenCode and Pi, and with any language whose test runner can write JUnit XML.
> NOTE: THIS IS NOT THE OFFICIAL PAPER REPOSITORY. It is just a plugin built based on my understanding of the paper. Please visit https://github.com/drixs2050/EvalAndMitigate for the official code

## Install

Requires **Node ≥ 20** and **git**. No API key: it runs on your existing harness subscription.

| Harness | Install |
|---|---|
| Claude Code | `/plugin marketplace add upadhyan/test-checker` then `/plugin install test-checker@test-checker` |
| Cowork | Add the same marketplace in Cowork's plugin settings and install `test-checker` |
| Codex | `codex plugin marketplace add upadhyan/test-checker` then `codex plugin add test-checker@test-checker` |
| OpenCode | Add `{ "plugin": ["@upadhyan/test-checker"] }` to `opencode.json` |
| Pi | `pi install git:github.com/upadhyan/test-checker` |
| Other | Copy `skills/test-checker` into your harness's skills folder |

## Use

In your repo:

- **Set up:** "set up test-checker". This writes and checks `.test-checker/config.yaml`.
- **Audit:** `/test-checker audit my tests`. Every unit gets blind, spec-derived tests. Existing tests that enshrine a bug are replaced once the bug is fixed; the rest stay.
- **After a bug fix:** "verify the tests for this fix".
- **New code:** "write verified tests for `parse_date`".

You get a short report of likely bugs, dropped tests and open questions, then the agent promotes the good tests into your suite.

## Repo layout

| Path | What |
|---|---|
| `skills/`, `agents/`, `prompts/` | The skill, blind subagent role cards, and the paper's prompts |
| `src/` → `dist/tcheck.mjs` | The `tcheck` engine (TypeScript, bundled and committed) |
| `.claude-plugin/`, `.codex-plugin/`, `.opencode/`, `pi-extension/` | Per-harness integrations |
| `fixtures/`, `tests/` | Selftest bug/fix pairs and unit tests |
| `docs/` | Design, engine contract and the paper's procedure |

See `CONTRIBUTING.md` for changing the code.

## Citation

If you use test-checker, please cite the paper it implements:

```bibtex
@misc{zhao2026misguidance,
  title         = {Evaluating and Mitigating the Misguidance Effect of Buggy Code in LLM-Generated Unit Tests},
  author        = {Zhao, Junda and Zhou, Shurui and Cohen, Eldan},
  year          = {2026},
  eprint        = {2607.22883},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE},
  url           = {https://arxiv.org/abs/2607.22883}
}
```

## License

MIT
