---
description: Prepare, run, or recheck an independent acceptance firewall
argument-hint: "<prepare|verify|recheck> [plan-or-spec-path] [fixed-point]"
---
Load and follow the `independent-acceptance` skill completely.

Mode and target:

```text
${@:-infer the mode and source document from the current request and worktree}
```

This is not an ordinary code review. Preserve the separation between specification, construction, and independent acceptance. Do not modify production implementation while verifying it.
