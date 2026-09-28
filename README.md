# test-checker

Makes your coding agent's unit tests **catch bugs instead of enshrining them**.

LLMs that write tests while looking at buggy code tend to write tests that pass on the bug. test-checker implements the procedure from Zhao, Zhou & Cohen, [*Evaluating and Mitigating the Misguidance Effect of Buggy Code in LLM-Generated Unit Tests*](https://arxiv.org/abs/2607.22883):

1. **Spec first:** derive what the code is *meant* to do.
2. **Blind generation:** write tests from that spec, without showing the implementation.
3. **Dual execution:** run the tests on the buggy and the fixed version, and classify each one as effective, misguided, neutral or broken.
4. **Adjudicate:** decide whether a failing test or the code is wrong, and ask you when the spec is ambiguous.

It works with any language whose test runner can write JUnit XML (nearly all of them).

## Install

Requires **Node ≥ 20** and **git** on your PATH. No API key is needed: everything runs on your existing Claude or ChatGPT subscription through the harness.

| Harness | Install |
|---|---|
| Claude Code | `/plugin marketplace add upadhyan/test-checker` then `/plugin install test-checker@test-checker` |
| Cowork | Add the same marketplace in Cowork's plugin settings and install `test-checker` |
| Codex | `codex plugin marketplace add upadhyan/test-checker` then `codex plugin add test-checker@test-checker` |
| OpenCode | Add `{ "plugin": ["@upadhyan/test-checker"] }` to `opencode.json` |
| Pi | `pi install git:github.com/upadhyan/test-checker` |
| Other | Copy `skills/test-checker` into your harness's skills folder. Blind generation runs through any installed harness CLI (`claude`, `codex`, `opencode`, `pi`) |

## Use

In a repo:

1. **Set up:** "set up test-checker". The agent writes `.test-checker/config.yaml` and checks that it works.
2. **Audit your tests:** `/test-checker audit my tests`. The agent rewrites every unit's tests blind from a spec and checks them against your code. Existing tests that enshrine a bug are replaced with verified ones once the bug is fixed; the rest stay.
3. **After fixing a bug:** "verify the tests for this fix".
4. **For new code:** "write verified tests for `parse_date`".

The agent runs the loop and gives you a short report:

- likely bugs, with the spec line each one violates and the existing tests that enshrine them;
- tests it dropped, and why;
- questions only you can answer.

When you're happy, it promotes the good tests into your suite.

## How blindness is enforced

| Harness | Mechanism |
|---|---|
| Claude Code / Cowork | Blind subagent whose only tool is `submit_tests`; a hook verifies it received the frozen spec payload |
| OpenCode | Hidden subagent with every permission denied except `tcheck_submit_tests`; same handoff check |
| Pi | Extension tool that calls the model directly with no tools |
| Codex | `codex exec` in an empty temp directory (optionally a direct API call, if you have a key) |

## Docs

- `docs/plugin-design.md`: architecture and harness decisions
- `docs/engine-spec.md`: engine CLI, MCP and hook contract
- `CONTRIBUTING.md`: rules and checks for changing the code
- `docs/test-verification-procedure.md`: the paper's procedure
- `skills/test-checker/references/config-reference.md`: every config field

## License

MIT
