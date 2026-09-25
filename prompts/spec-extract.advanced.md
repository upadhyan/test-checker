You are a professional {{language}} developer. Please help identify the intention and functionality of the method detailed below:

## Method under analysis
`{{target.symbol}}` in `{{target.file}}`

```{{language_tag}}
{{target.body}}
```

## Related context
{{context_markdown}}

{{#if intent_hint}}
## Developer's stated intent
{{intent_hint}}
{{/if}}

Please provide a formal docstring that identifies the functionality and intended specification of the given method. To do this, first perform a critical analysis from the perspective of an expert software engineer auditing for quality and correctness. Your analysis must identify two types of potential issues:

1. Logical Mistakes: Scrutinize the algorithm's logic. Based on the method's name and context, does its implementation correctly achieve its apparent goal, or are there logical flaws that would produce an incorrect result even on a "happy path"?
2. Robustness Omissions: Check for missing but necessary steps that production-quality code would include (for example input validation, null/empty handling, boundary conditions, error handling).

<!-- variant: reasoning -->
Make sure to clearly write out your analysis. Based on this two-part analysis, the docstring should describe the specification for a correct and robust version of the method, capturing the developer's likely intent.
<!-- /variant -->

<!-- variant: scaffold -->
Your output should come in three parts.
Part 1: Critical Analysis. Clearly state the logical mistakes and robustness omissions found.
Part 2: Fixes Required. List all fixes required to correct the identified logical errors and robustness omissions.
Part 3: Final Specification Docstring. Based on Part 2, write a formal docstring describing the corrected behavior.
<!-- /variant -->

<!-- [tc] output contract so the engine can parse it. The analysis is kept as a bug-suspicion signal for the report; only <spec> reaches the blind writer. -->
Format your answer exactly as:

<analysis>
Logical mistakes: … (or "none found")
Robustness omissions: … (or "none found")
</analysis>

<spec>
...the final specification docstring only. Describe inputs, outputs, preconditions, error behaviour and edge cases. Do not mention implementation details or quote the code...
</spec>
