---
name: why
description: Show the last few things the jev hooks said to Claude — the exact note or tripwire text, the signals behind it, and the marker text of any re-issue.
disable-model-invocation: true
argument-hint: "[count] [notes|trips]"
allowed-tools: Bash(node:*)
---

# /jev:why

Run exactly this command with the Bash tool, passing through whatever the user
typed (a count, a filter, both, or neither), and show the output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" why $ARGUMENTS
```

With no arguments it shows the last three notes, tripwires, re-issues and errors.
`notes` narrows it to notes; `trips` narrows it to the tripwire story — each trip,
every repeat, and how it ended.

Each entry prints the tool, the redacted subject, the prefilter verdict, the raw
probabilities, and — the line that usually answers the question — **`said to
Claude:`**, the exact text the agent was handed. A re-issue also prints `marker
text:`, which is the reason Claude gave for going ahead, and `quote verified in
…:`, the user message its quote was found in (or `quote refused:` and why, for a
marker that cleared nothing). That pair is the audit trail for the tripwire: read
the quote against the call, and say plainly if the user's words do not really ask
for it. A judged call also lists any `standing instructions read:`, the earlier
prompts the scope judgment was given besides the last five.

If an entry looks wrong to the user:

- a **note** that was not worth the context: raise `auto_threshold` (run
  `/jev:calibrate` first — it replays your own log at other values), or set `gate`
  to `off`;
- a **tripwire** that should not have fired: the same, and note that a re-issue
  with a marker quoting the user's words already passes without another judgment;
- a **pattern** entry has a `prefilter` line and no signals. It came from a code
  rule, so no threshold change will affect it.

Nothing here was ever a prompt to the user. If the user expected to be asked,
`ask_on_trip` is the setting that does that.
