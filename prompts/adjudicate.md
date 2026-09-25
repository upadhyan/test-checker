You are adjudicating a disagreement between a unit test and the code it tests. The test was written blind, from a specification, without seeing the implementation. It fails against the code as it stands.

Decide which side is wrong. Neither side is presumed correct.

## Specification
{{spec}}

{{#if analysis}}
## Spec-extractor's suspicions about the code
{{analysis}}
{{/if}}

## The failing test
```{{language_tag}}
{{test_source}}
```

## Failure
```
{{failure_output}}
```

## Implementation
`{{target.symbol}}` in `{{target.file}}`{{#if revision}} at `{{revision}}`{{/if}}
```{{language_tag}}
{{target.body}}
```

Verdicts:
- `code-wrong`: the test asserts behaviour the spec requires, and the implementation violates it. This is a likely bug.
- `test-wrong`: the test asserts something the spec does not require, misreads the spec, or has a mistake of its own.
- `spec-ambiguous`: the spec genuinely supports both readings, or is silent on this case. A human must decide.

Rules:
- Quote the exact spec sentence your verdict rests on. If there isn't one, the verdict cannot be `code-wrong`.
- Prefer `spec-ambiguous` over guessing.
- Do not propose code or test fixes here.

Answer exactly as:

<verdict>code-wrong | test-wrong | spec-ambiguous</verdict>
<spec_basis>quoted spec sentence, or "none"</spec_basis>
<reason>two or three sentences</reason>
