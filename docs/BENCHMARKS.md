# jev benchmarks

Measured 2026-09-21 on jevwire 0.6.2, from a real decision log (1,017 records of ordinary Claude Code
use) plus in-process microbenchmarks and the built bundle. Numbers are what the deployed plugin
actually did, not a synthetic loop — the log is one developer's session with the gate, stop check,
screen and lint all on.

## Bundle size (what ships and cold-starts on every hook)

| bundle | size | deps |
|---|---|---|
| `plugin/dist/hook.mjs` | **287 KiB** | none (no zod, no MCP SDK) |
| `plugin/dist/mcp.mjs` | 1,469 KiB | MCP SDK + zod (only loaded when the MCP server runs, not on hooks) |

The hook bundle is deliberately dependency-free: it is parsed on every tool call on the command-hook
fallback path, and its cold start is a tax on the whole session. A static test holds it under 300 KiB.

## The common case is free: the skip path (no model call)

Most tool calls never reach the model. A read-only command, or an edit that matches no lint gate, is
decided in code by the prefilter and the regex gate:

| step | per call | what it decides |
|---|---|---|
| `prefilter` (Bash skip-path) | **~24 µs** | is this a read-only/allowlisted call → no judgment |
| lint regex gate (no match) | **~9.6 µs** | does this edit match any lint pattern → no model call |

At tens of microseconds, the skip path is free relative to the tool call it precedes. This is the
mechanism behind "most edits cost nothing": the model is asked only when a regex first found the shape.

The daemon skip-path (an http hook that resolves without a model) answers in **~1.4 ms** end to end
(measured warm at release); the command-hook fallback pays node's cold start (~0.5–2 s) but only when
the daemon is not up.

## When the model is asked: judged latency (live)

Over 740 real model calls in the log (memo hits and the one aborted outlier excluded):

| latency | value |
|---|---|
| p50 | **536 ms** |
| p95 | **1,168 ms** |

Both sit under the 1,500 ms per-call hook timeout, so a judged hook rarely times out on the hot path.
A memoized repeat of an identical call returns in ~3 ms with no tokens spent.

## Cost (live)

- **~1.53M input tokens** across the whole log's lifetime → **≈ $0.064** at $0.042/Mtok (Jev bills input
  tokens only). That is the cost of a heavy development session with every hook on.
- The gate is the bulk of it (689 PreToolUse records); the stop check (20) and screen (33) are a small
  tail. Lint had just been installed, so it is barely represented yet (6 records).

## What the hooks actually did (live decision mix)

| event | total | outcomes |
|---|---|---|
| PreToolUse (gate) | 689 | allow 500, silent-scope 73, advise 49, note 17, ask 17, **trip 10**, error 7 |
| Stop | 20 | allow 18, (blocks are rare and one-per-prompt) |
| PostToolUse (screen) | 33 | clean 31 |
| UserPromptSubmit | 58 | prompt recorded |
| verification (code, no model) | 200 | test/typecheck/build results tracked for the stop check |

Read this as the design intends: the overwhelming outcome is **silent** (allow), notes are occasional,
and trips (denials) are rare — 10 in 689 gate decisions, each re-issuable with a marker.

## How to reproduce

- Bundle: `npm run build` then `ls -la plugin/dist/*.mjs`.
- Skip-path microbench: a tight loop over `prefilter(...)` and `lintPrefilter(...)` (both pure, no
  network); warm first, then time.
- Live numbers: `npm run capture -- --summary <fixture>` for the policy view, or read
  `~/.claude/plugins/data/jev-<marketplace>/decisions.jsonl` directly — every judged record carries its
  `latency_ms` and `input_tokens`.

These feed the verdict phase directly: the targets there are judged p50 ≤ 450 ms (currently 536 ms —
close, and dominated by network RTT to the API, not the plugin), skip ≤ 10 ms (met, ~1.4 ms), and cost
≤ $0.05/day (a heavy day here was $0.064, an ordinary day well under).
