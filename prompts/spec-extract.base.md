You are a professional {{language}} developer. Please help identify the intention and functionality of the method detailed below:

## Method under analysis
`{{target.symbol}}` in `{{target.file}}`

```{{language_tag}}
{{target.body}}
```

## Related context
{{context_markdown}}

Please provide a formal docstring that identifies the functionality and intention of the given method. Please avoid directly quoting from the focal method code, as it might be buggy, and output only the docstring.

<!-- [tc] output contract so the engine can parse it -->
Wrap the docstring in a single block:

<spec>
...docstring...
</spec>
