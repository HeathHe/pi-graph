# Coordinate Step {{STEP_N}} — {{GRAPH_NAME}}

## Command
{{COMMAND}}

{{#AUTO_DIRECTIVE}}
**Mode:** {{AUTO_DIRECTIVE}}
{{/AUTO_DIRECTIVE}}

{{#PREVIOUS_CONTEXT}}
## Context from Previous Step
{{PREVIOUS_CONTEXT}}
{{/PREVIOUS_CONTEXT}}

{{#STATE_SNAPSHOT}}
## Current State
{{STATE_SNAPSHOT}}
{{/STATE_SNAPSHOT}}

{{#INTENT}}
## Original Intent
{{INTENT}}
{{/INTENT}}

## Report Status (Required)

Before finishing, run exactly this command (substitute values based on what
you accomplished). This is the ONLY way the coordinator learns your result —
text output alone is not read.

```
maestro coordinate report \
  --session {{SESSION_ID}} \
  --node {{NODE_ID}} \
  --status <SUCCESS|FAILURE> \
  [--verification <passed|failed|pending>] \
  [--review <PASS|WARN|BLOCK>] \
  [--uat <passed|failed|pending>] \
  [--phase <number>] \
  [--artifact <path>] [--artifact <path>] \
  [--summary "<one-line what was accomplished>"]
```

Legacy fallback (only if the report command is unavailable): append this
block at the end of your output. The coordinator will parse it as a
last-resort contract.

```
--- COORDINATE RESULT ---
STATUS: <SUCCESS or FAILURE>
PHASE: <number, or "none">
VERIFICATION_STATUS: <passed or failed or pending, if applicable>
REVIEW_VERDICT: <PASS or WARN or BLOCK, if applicable>
UAT_STATUS: <passed or failed or pending, if applicable>
ARTIFACTS: <comma-separated file paths, or "none">
SUMMARY: <one-line what was accomplished>
```
