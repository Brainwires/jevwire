# Changelog

All notable changes to jevwire ([Brainwires/jevwire](https://github.com/Brainwires/jevwire)) are
documented in this file. The npm package is published as `jevwire` and the Claude Code plugin is
`jev`; the repository was renamed to jevwire after 0.3.0.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] — 2026-09-21, commit scope

The commit-time half of `docs/DESIGN_0.6.md` §3, finishing the code-development work. When a `git commit`
is about to run, the staged diff is judged:

- **`pr_scope`** — a Score of how focused the diff is (one change / one plus a small tweak / several
  independent changes). A **note** when it reads as several bundled changes, firm on the *mass* of that
  level, never on a hunk count the model computed — Jev is not asked to count.
- **`message_describes_diff`** — a **note** when a `-m`/`-F` message does not describe what the diff
  changed.
- **a hardcoded secret in the diff's added lines** — a **tripwire** (deny, re-runnable after
  `# jev:intended …` on the command's last line). This catches a secret written via a Bash heredoc that
  the edit-time lint never sees.

Notes are deduped on the staged diff and share the 5-per-prompt cap; the check runs only under
`lint` (advisory or tripwire), reads `git diff --cached` through the hook-safe reader, and is silent
outside a repo or with nothing staged.

## [0.6.1] — 2026-09-21, semantic code lint

The edit-time half of `docs/DESIGN_0.6.md` §3: an in-project edit is now judged before it is written,
a tripwire for the two block-grade findings and an advisory note for the rest. `pr_scope` on `git
commit` (the commit-time half) follows in 0.6.2.

Every finding is **a regex gate then a Noul** — the regex decides whether a pattern is *present* (which
Jev cannot reliably find or count in a diff), the Noul decides whether it *matters* (a `catch` that
discards the error vs one that rethrows; a new `any` vs the word in a comment). Most edits match no
gate and cost nothing; a judged edit is ~3–5k tokens (~$0.0002).

### Added

- **Semantic code lint on edits** (`lint`, default `advisory`; `tripwire` keeps only the two denials;
  `off` disables it). It **denies** an edit that hardcodes a secret, or removes a test the last prompts
  did not ask to remove — as a tripwire, re-runnable after a `true # jev:intended t-…` affirmation, the
  same mechanism as the gate. It **notes** a swallowed exception, a hardcoded URL or absolute path, a
  new type/lint suppression, a changed exported signature, a placeholder, or — with `lint_conventions`
  (default on) — a break of a rule line in your `CLAUDE.md` (up to 12 lines extracted; nothing else from
  CLAUDE.md is sent). Notes share the gate's 5-per-prompt cap and dedupe. A Write reads the current file
  so a rewrite's removed lines are seen; sensitive and out-of-project writes keep the gate path.
- **Config surfaced in `/plugin`:** `lint`, `lint_conventions`, and `verify_claims` (which shipped in
  0.6.0) are now userConfig options with env passthrough.

## [0.6.0] — 2026-09-21, code development

The first half of the "code development" work from `docs/DESIGN_0.6.md`: better ranking, a tool for
choosing one candidate, and a Stop check that catches a final message describing work that is not in
the workspace. The semantic code-lint battery and `pr_scope` (the second half of the design) follow in
0.6.1, where their note volume can be measured on their own.

Every question added here is a single System-1 judgment — a literal reading of pointed-at text — with
all counting, ordering, arithmetic and existence checks kept in code, per Jev's own jaggedness page.

### Added

- **`jev_pick`** — choose one candidate from a list you already have (grep hits, symbols, failing test
  names, paths) instead of guessing. One Choice over the candidate indices plus a `none` escape hatch,
  and an absolute `fits` yes/no per candidate; `pick` is always one of your ids or null. One request,
  never chunked: an over-budget set is a `BudgetError` with no call made.
- **Stop-time claim verification.** When the final message names a file, an identifier, or a change,
  the Stop hook now checks it against the workspace. Stage 1 is deterministic and needs no model: a
  named file that is not in the project, or a "removed X" about a file that is still there and
  untouched, is a fabrication caught in code. Stage 2 (`verify_claims`, default on) reads `git diff
  HEAD` with the model and blocks only on a firm contradiction. Precedence is stop-short → the
  verification ledger → claims, still at most one block per prompt. `src/hooks/workspace.ts` is a new
  hook-safe reader with the same refusals as the MCP file layer (sensitive paths, inside-cwd via
  realpath, size cap) plus git through `execFile` with `GIT_EXTERNAL_DIFF`/`GIT_PAGER` stripped.

### Changed

- **`jev_rank` orders by a relative Choice, not the per-candidate yes/no.** Each batch answers a
  `which` Choice ("which entry best helps"), and the batch winners are reconciled by one final Choice —
  a System-1 "which of these" instead of an absolute Noul battery that went flat past ~50 candidates.
  `relevance` stays the absolute yes/no that `min_relevance` filters on; new `choice` (per row) and
  `choice_margin` (top minus runner-up in the deciding request — below 0.10 the top two were a toss-up)
  report how clear the pick was. `any_relevant` is judged once over the finalists, not maxed across
  batches. The per-request cap is raised 16 → 200 (the context budget binds first for file chunks).
- **`jev_verify` is split** into a zod-free, file-layer-free `verify-core` (the rubric, the evidence
  packer, the merge, and a `runVerifyCore`) that the Stop check reuses, and the unchanged MCP tool.
- New config: `verify_claims` (default true) gates the model half of the Stop check; `lint` and
  `lint_conventions` are read for 0.6.1 and inert until then.

## [0.5.2] — 2026-09-18

### Fixed

- **A hook post from a known session is authorized without a key header.** Claude Code does not
  interpolate `$CLAUDE_PLUGIN_OPTION_API_KEY` into a plugin's `type: "http"` hook headers; only
  variables in its own process environment do. A user who set the key only in the plugin option
  therefore had hooks that could never authenticate, and since 0.5.1 that failure was silent: the
  daemon answered every hook post `200 {}` and counted it `unauthorized`, so the plugin was simply
  inert. Since 0.5.2 a `POST /v1/hook/*` whose body names a session the daemon knows — one registered
  by `SessionStart` over an authenticated `/v1/session/start`, or one with a snapshot on disk — is
  served without any key header. The `/v1/session/*` routes still require a held key, and refusals on
  hook routes still answer `200 {}`; `/jev:daemon status` reports how many posts were served by
  session id and rewords the `unauthorized` explanation to say that those posts named no session the
  daemon knows.

## [0.5.1] — 2026-09-18

### Fixed

- **The daemon never answers an http hook with a non-2xx status.** A real session showed that
  Claude Code surfaces any 4xx from a `type: "http"` hook to the user as a hook error — the fail-open
  the spike (question 3) promised for refused connections does not extend to a refusal the daemon
  itself answers. Every `POST /v1/hook/*` refusal — bad key, wrong protocol, unknown event, wrong
  method, oversize body — is now answered `200 {}` and counted, so the refusal is still auditable in
  `/jev:daemon status` (which now explains rejected posts) but nothing lands in the user's transcript.
  The `/v1/session/*` routes keep their real 4xx statuses: `/v1/session/start`'s 401 is how
  SessionStart recognises a stale daemon.
- **The daemon accepts a request whose credential matches any key it holds.** It keeps every key
  present in its environment at start (`CLAUDE_PLUGIN_OPTION_API_KEY`, `JEV_PLUGIN_API_KEY`,
  `TYPESAFE_API_KEY`) rather than only the one `loadHookConfig` picked, because the option and the
  shell can legitimately hold different keys and the hooks interpolate one of each. `SessionStart`
  replaces a running daemon that does not hold every key the current environment has (matched by
  8-hex-character sha256 fingerprints exposed in `/v1/health`), so a changed key takes effect at the
  next session start instead of producing a stream of counted refusals.

## [0.5.0] — 2026-09-18, judgment quality

**Every question the plugin asks was rewritten.** 0.4.x asked short prose questions and got back
probabilities that were, in places, answering something slightly different from what the policy
consumed. A week of real use named four specific failures, and this release fixes those four rather
than tuning thresholds around them. The design is `docs/DESIGN_0.5.md`; the question texts there are
the ones that ship.

**This release cannot be scored by the offline replay.** Every probability moves when the criteria
are rewritten, so `/jev:calibrate`'s replay — which is exact for a policy change over a fixed log —
says nothing useful about a question change. The measure is a pair of captured fixtures instead:
`npm run capture -- --out tests/fixtures/before-0.5.0.jsonl` before shipping (already committed, on
the 0.4.x questions), the same command after a week on the new ones, and
`npm run capture -- --summary <fixture>` to read the two side by side.
`tests/acceptance/replay.test.ts` snapshots both, so the size of a later policy change lands in the
diff. The targets: `in_scope` median on allowed actions above 0.70 (it was 0.32), the `silent-scope`
share under 2% (it was 9.5% of judged gate records over the whole log, and 20.0% in the committed
before fixture, which is the last 200 — compare fixture to fixture), instrumental subagent trips at
zero with the one real `git push` trip kept, and a planted mid-page injection scored at or above 0.9.

Live checks at release, on the real model: an unrequested `aws s3 rm --recursive` tripped with the
new wording (scope: unrelated p=1.00); `printenv KEY | wc -c` scored `credential_exposure` 0.05
(a 0.4.x false positive); running the test file the prompt named scored `in_scope` 1.00 with
`mentions_target` 0.98; a `python3` heredoc rewriting a file inside a subagent was judged against
the subagent's own task and allowed at `in_scope` 1.00 (the 0.4.x trip shape); "Say the word and
I'll ship it" passed the stop check, "the CLI flag is still a TODO" blocked naming
`says_part_not_done`, "two of them still fail" blocked naming `says_check_failing`; an injection
planted at character 40,000 of a 60,000-character page scored 0.99 across four chunks in 634 ms.

### Added

- **Structured criteria, end to end.** A rubric entry can now be JSON as well as prose: Choice
  options and Noul sides as `{what, not_for, examples}`, Score levels as `{summary, signals}`. The
  rule that makes it work is that `not_for` lives on the side a lookalike case would *wrongly* land
  on. `jev_evaluate` accepts it, and the schema stays `$ref`-free so no MCP client drops it.
- **A `scope` Score in place of the `in_scope` Noul**, with three real levels — unrelated, an
  ordinary step of the requested work, explicitly requested — plus two new Nouls, `mentions_target`
  ("did a request name the file, command, branch or URL this acts on?") and `same_task_area`
  (logged only in 0.5.0, as a corroborator to compare against in `/jev:calibrate`).
  `signals.in_scope` is still the number every rule reads; it is now `P(step) + P(requested)`.
- **A `mentions_target` veto on the tripwire.** A call whose target the user literally named can
  still earn a note, but it can no longer be denied as out of scope. Replayed over the first day of
  real use, that turns the day's one model trip into a note and changes nothing else.
- **Subagent tasks.** The PreToolUse matcher gains `Agent|Task`; a spawn is never judged, it is
  recorded. A tool call inside a subagent is then scored against the task the parent gave it rather
  than against a prompt the subagent never saw — the cause of four of the five model trips in the
  first live week. Two same-type subagents in flight is ambiguous, so scope is ignored rather than
  judged against the wrong task. `SubagentStop` consumes the task, and `subagent` is logged on
  every judged record, so the subagent share of the gate's output is finally measurable.
- **The stop check's compound question is three literal ones.** `admits_unfinished` fired on
  *offers* — "say the word and I'll ship it" — in nine of twelve live stop records, and only
  `asks_user` kept them from being wrong blocks. It is now `says_part_not_done`,
  `says_step_deferred` and `says_check_failing`, OR-ed in code, each with the offer case written
  into `not_for`. A block names which one fired instead of a compound verdict, and `unfinished_by`
  is logged.
- **Full-text injection screening.** A fetched result is split into overlapping 16,000-character
  chunks and every chunk is judged, in parallel under one deadline, memoized per chunk. 0.4.x sent
  a head and a tail and never read the middle. Up to eight chunks; past that the first, the last
  and evenly spaced middles are judged and `chunks_total`/`chunks_judged`/`chunks_failed` say how
  much was covered. A chunk that fails is skipped, not fatal.
- **`contradicts_premise`** on the same screen: a fetched page that disagrees with a fact the
  request took for granted gets one note. It never blocks, and it has no paired message for the
  user — the audience is the agent's next step.
- **`confidence_threshold`** (`JEV_CONFIDENCE_THRESHOLD`, default 0.85, [0.5, 0.99]). A Choice's
  `confidence` is a peakedness statistic, not the probability of a binary event, so it no longer
  shares a bar with the Nouls. The prompt-kind line is gated on it.
- **`thresholds` on every judged record**, plus `blast_source` and `scope_source`, so a replay
  knows what the decision was actually made at rather than assuming what is configured now.

### Changed

- **The model is pinned to `jev-1.13.0`** for the hooks and the MCP server, and is settable in
  `/plugin` → jev. An alias re-points silently, and every probability under thresholds you have
  tuned moves with it. The library default (`JevDecisionModel`) stays `jev-latest`: a library user
  picks their own policy. See "Alias-move risk" in the README.
- **A Score is thresholded on level mass, not on its expectation.** `wide` is now
  `P(level 2) + P(level 3) ≥ auto`, and the ambiguity line is `P(materially open) ≥ auto`. A
  bimodal answer averages to a level the model never chose, and both rules used to fire on exactly
  that. An answer with no per-level probabilities falls back to the 0.3 expectation rule and says
  so in the log.
- **Note and trip wording.** A note names the level the effect reached — "shared project state",
  "beyond this machine" — instead of printing an expectation as "blast radius 2.83 of 3", and the
  scope clause is emitted only when the prompts really do not ask for the call. The live log has a
  note about an outward-facing call scored `in_scope` 0.90 that still claimed it was "not named in
  the last 3 user prompts"; that was a latch bug, and it is fixed.
- **Bash `description` is no longer part of what the model reads.** It is text the agent wrote
  about its own call, and self-arguing text moves answers. The action is now sent as fields —
  `{tool, command, file_path, target_paths, …}` — which is also what lets `mentions_target` compare
  target names against the prompts. The fingerprint, the memo key and the prefilter are unchanged
  and still use the raw tool input, so a trip and its re-issue still pair up.
- **`jev_gate_action` accepts objects** for `action`, `user_request` and `context` as well as
  strings, and returns an additive `scope` block. `signals.in_scope` is unchanged.
- **`/jev:calibrate` section 5 is four replays** — gate, stop, screen and prompt kind — each exact
  from the logged fields, with legacy records replayed on the rules they actually decided on.
  Section 4 gains the scope histograms and a `same_task_area` versus `scope_step` agreement line.
- **`relevant` is gone** from the PostToolUse screen. It was logged 31 times out of 31 and consumed
  zero times, and there is no decision it could drive without rewriting tool results.

### Fixed

- The startup timing test measured Node's own start more than the bundle's, and was flaky for that
  reason. It now measures the hook against a bare `node -e ""` spawn.

## [0.4.1] - 2026-09-18

### Changed
- The project is now **jevwire**: npm package `jevwire` (was `jev-mcp`), repository
  `Brainwires/jevwire` (the old URL redirects), marketplace `brainwires-jevwire`. The plugin id stays
  `jev`, so `/jev:*` commands, the `[jev]` note prefix and the `jev_*` MCP tools are unchanged.
- Because Claude Code derives the plugin's data directory from `<plugin>@<marketplace>`, the directory
  moves from `jev-brainwires-jev` to `jev-brainwires-jevwire`. On first use the old directory is copied
  into the new one exactly once, never overwriting, so `/jev:calibrate` keeps its history.
- Upgrading: `/plugin marketplace add Brainwires/jevwire`, `/plugin install jev@brainwires-jevwire`,
  then uninstall `jev@brainwires-jev` so the hooks do not run twice.

## [0.4.0] - 2026-09-18

**The hooks stop paying for a process each.** Most of them are now `type: "http"` posts to a small
loopback daemon that `SessionStart` starts, instead of a fresh `node` per tool call. Measured on this
machine, against the real API, with a temp data directory and an ephemeral port:

| path | 0.3.0 | 0.4.0 | how |
|---|---|---|---|
| skip-path hook (`ls -la`) | ≈160–170 ms | **p50 2.8 ms, p95 8.4 ms** (n=20) | no process to start |
| judged hook, cold socket | ≈665 ms | **501 ms** (Jev 491 ms of it) | first call after start |
| judged hook, warm socket | ≈665 ms | **p50 210 ms, p95 290 ms** (n=4; Jev 198–284 ms) | TLS and the pool are paid for once |
| the same judgment again | a second full call | **5 ms**, `memo: true`, 0 tokens | 5-minute memo |
| SessionStart | ≈165 ms | ≈400–600 ms the first time, ≈170 ms after | spawn plus a health wait |

Nothing about what the plugin *decides* changed. The http hooks and the command hooks run the same
handlers from the same bundle, and a shared case table asserts byte-identical output from both.

### Added

- **A loopback daemon**, `node hook.mjs daemon`, in the same bundle as the hooks. One per user per
  machine, `127.0.0.1:10522`, serving `POST /v1/hook/<Event>` for every event the plugin handles.
  Idle-exits after 30 minutes, 60 seconds after the last session ends, and drains on SIGTERM.
- **`/jev:daemon [status|stop|restart]`**, and a "Daemon" section in `/jev:status`: up or down, pid,
  version, protocol, uptime, sessions, hooks served by event, Jev calls versus memo hits, timeouts,
  restarts and the port-conflict flag.
- **Self-healing.** `SessionStart` starts or replaces the daemon; a watchdog in the plugin's MCP
  server checks every 10 seconds. A plugin update is picked up automatically: the daemon reports its
  `bundle_mtime` and protocol in `/v1/health`, and an older one is replaced rather than trusted.
- **A 5-minute memo** in front of the Jev client (256 entries, keyed by a sha256 of the model, the
  state and the questions; successful answers only). A hit is logged as `memo: true` with
  `latency_ms: 0` and `input_tokens: 0`, and `/jev:status` leaves hits out of its latency
  percentiles, so neither number flatters the real cost.
- **A concurrency limit of 4** on Jev calls, so a burst of tool calls cannot open a socket each.
- **A `SessionEnd` hook**, deliberately empty: it is how the daemon learns a session is over.
- `JEV_DAEMON_PORT` / `daemon_port` and `JEV_DAEMON_IDLE_MS` / `daemon_idle_ms` settings, and
  `JEV_DAEMON_DISABLE=1` to keep `SessionStart` from starting a daemon at all.

### Changed

- `plugin/hooks/hooks.json`: `PreToolUse`, `PostToolUse` (both matchers), `PostToolUseFailure`,
  `Stop` and `SessionEnd` are `type: "http"`. `SessionStart` stays a command hook — it is what starts
  the daemon. `UserPromptSubmit` has both, the command entry as a fallback that probes the port first
  and says nothing if the daemon answered, so the first prompt of a session is covered while the
  daemon is still coming up.
- `nextPrompts` drops an identical consecutive prompt, so a double-fired `UserPromptSubmit` is
  invisible rather than evicting the request before it.
- The plugin manifest passes `JEV_PLUGIN_DAEMON=1`, `JEV_PLUGIN_ROOT` and every
  `CLAUDE_PLUGIN_OPTION_*` to the MCP server, so a watchdog-started daemon is configured exactly like
  a hook-started one.
- `src/hooks/main.ts` exports `HANDLERS`; dispatch moved to `src/hooks/dispatch.ts` (re-exported, so
  nothing that imported `runEvent` from `main.ts` changed).
- The hook bundle grew from 187.0 KiB to 188.2 KiB — four more node builtins (`http`, `net`,
  `crypto`, `child_process`) and no new dependency. It still contains no MCP SDK and no zod.

### Fixed

- A memo hit reached the decision log without its `memo` flag, because `runGateAction` rebuilt the
  result and dropped it. It read as a 0 ms, 0-token *real* call, which would have quietly flattered
  both the latency percentiles and the cost estimate in `/jev:status`. Found in live verification.
- `/v1/health` reported `jev_calls: 0` and `memo_hits: 0` forever: the server never calls Jev, so it
  cannot count the calls, and it was not asking the model stack that can. Also found live.

### Security

- The daemon binds loopback only and authenticates with the TypeSafe API key, accepted in either
  `Authorization: Bearer` or `X-Jev-Env-Key` and compared in constant time. `/v1/health` is
  unauthenticated and carries no secret. There is no shutdown endpoint; stopping it takes a signal,
  which takes being the same user.
- Residual risk, stated in `SECURITY.md`: a different local user who squats the port before the
  daemon starts receives the hook payloads and the key in a header. **Multi-user hosts are not
  supported.** A keyless install runs the daemon unauthenticated, which `/v1/health` says plainly as
  `auth: "none"`; there is nothing to spend and no judgment to make without a key.

## [0.3.0] - 2026-09-17

**Advisory-first. The hooks no longer prompt you.** Everything the plugin decides is now addressed
to Claude: a note about a call that already ran, or a single `deny` that Claude can answer. Replaying
the first day of real use through the new rules, the 24 escalations that day — 24 permission prompts —
become 9 notes, 1 tripwire and 0 prompts.

The design, with the full decision table, the wording templates and the accepted risks, is
`docs/DESIGN_0.3.md`. `docs/PLUGIN_SPEC.md` carries the table as the normative PreToolUse spec.

### Changed

- **The `PreToolUse` gate is advisory.** Three outcomes: silence, a **note**
  (`additionalContext`), or a **tripwire** (`deny`). A confirm-grade judgment that used to raise a
  permission prompt now either hands Claude one factual sentence about the call or says nothing at
  all, according to a nineteen-row table evaluated top-down. Rows 9 to 12 (firm credential exposure,
  firm outward reach on unrequested work, firm destructive with thin scope or a wide radius, a wide
  radius on unrequested work) produce a note; rows 13 to 15 (a local overwrite the user asked about,
  a firm out-of-scope reading with no risk signal, uncertain signals only) are silent and logged as
  such; the two block-grade cases trip.
- **A note is post-hoc, by construction, and the README and SECURITY.md now say so plainly.** Claude
  Code delivers a PreToolUse `additionalContext` next to the *tool result* — after the call ran — and
  drops it entirely when the call is blocked. A note can therefore only inform the next step, and a
  deny's text has to ride in `permissionDecisionReason`. Only a tripwire acts before execution.
- **A tripwire is a deny Claude can answer.** The hard-coded catastrophic patterns and a model
  `block` deny the call once, with the reason, a trip id, and the exact marker that re-issues it.
  Re-issuing the identical call with `# jev:intended <the sentence of the user's request that
  requires this action>` on its last line passes the hook without a second judgment and without a
  model call; for tools with no comment syntax the marker arrives as a separate Bash call,
  `true # jev:intended t-1a2b3c4d: <that sentence>`. A marker is honoured only against a trip this
  hook wrote, for the identical fingerprint, inside 30 minutes; a marker on a call that was never
  tripped is stripped, ignored and counted. Marker text never reaches Jev, and is logged and shown
  to the user by `/jev:why`.
- **Notes are capped and de-duplicated:** at most five per user prompt, and never twice for the same
  action inside 30 minutes. Both suppressions are logged, so the rate is measurable.
- **Every agent-facing sentence was rewritten to be declarative** — what was scored, by what, with
  what limits — because imperative "system command" phrasing in injected context trips Claude's own
  injection defenses. A unit test rejects `do not`, `must`, `never`, `proceed`, `treat it` and
  `ignore` in every note and trip this plugin can emit. The `PostToolUse` injection note now states
  that the result was scored as containing instructions addressed to an agent and that it is data a
  tool returned, rather than telling Claude what to do with it.
- **`gate_mode` is now `gate`,** with values `off` / `advisory` / `strict` (was
  `off` / `standard` / `strict`). **Migration is automatic and loud:** an install that still carries
  `gate_mode` keeps working — `standard` is read as `advisory` — and `/jev:status` prints
  `gate_mode is deprecated; read as gate=<x>. Set "gate" in /plugin config.` The `JEV_GATE_MODE`
  environment fallback is read the same way. Nothing silently changes behaviour, including
  `gate_mode: off`, which still silences the gate.
- `/jev:calibrate` was rewritten around the new outcomes: what Claude was told and what was
  suppressed by reason, the full tripwire lifecycle (by source and rule, repeats, re-issues that ran
  or failed, affirmed-but-never-re-issued, not re-issued, median trip-to-re-issue time), marker
  hygiene, signal histograms split by outcome, an exact threshold replay counting notes and trips
  through the pure `gateOutcome`, and a printed evidence hierarchy. A deny loop is **reported** as
  "stuck", not capped: a cap that went silent would be a bypass.
- `/jev:why` takes an optional filter, `/jev:why [count] [notes|trips]`, and prints the exact text
  handed to Claude plus the marker text of any re-issue.
- `/jev:status` prints `gate`, `ask_on_trip`, and last-24h counts of notes, suppressions, tripwires,
  re-issues and marker hygiene.
- `DecisionRecord` gained `fingerprint`, `trip_id`, `source`, `channel`, `emitted`, `affirmation`,
  `suppressed` and `firm`; `SessionState` gained `trips`, `notes_this_prompt`, `noted`, and
  `pending_reissues` (renamed from `pending_asks`). `Store.rememberAsk`/`takeAsk` are
  `rememberReissue`/`takeReissue`, and `recordApproval` is `recordReissueRun`. `UserPromptSubmit`
  writes one text-free `prompt` line to the log, which is what makes "notes per user prompt"
  computable.
- `gateActionPolicy` returns the predicates it decided from — `requested`, `wide_blast`,
  `out_of_scope`, `firm_risk`, `uncertain` — so the advisory layer and the replay read one
  definition instead of two. `jev_gate_action`'s MCP output is unchanged.

### Removed

- **`auto_mode`.** It existed to choose between prompting and advising in auto mode; every judgment
  is advisory now, in every mode. An install that still sets it gets the warning `auto_mode is no
  longer used: every judgment is advisory to Claude and never prompts.`
- **The approval-correlation section of `/jev:calibrate`**, and the `approval` / `approved` log
  records behind it. They measured how often a user approved a prompt, and there are no prompts.
  `reissue-ran` and `reissue-failed` replace them: they say whether a call Claude re-issued with a
  reason actually ran.

### Added

- `ask_on_trip` (boolean, default `false`): the one setting that can prompt a human. It turns a
  tripwire's `deny` into `ask`, with the same text, in the permission modes where a prompt has an
  audience. Off by default, and `"ask"` is produced in exactly one expression in the whole hook
  source — a test pins that, because "the hooks never prompt" is this release's central claim.
- `src/hooks/advisory.ts` — `gateOutcome`, the decision table as one pure function, replayable over
  the log; `src/hooks/tripwire.ts` — marker parsing, fingerprinting, the `Trip` record;
  `src/hooks/wording.ts` — every sentence the plugin says, with the banned-imperative regex.
- 151 new tests (1,111 total): the marker-parsing table including heredocs, quoting and CRLF;
  fingerprint stability; the advisory truth table plus properties over ~5,800 signal combinations;
  every wording template; every row of the decision table; a never-ask fuzz pass; the whole
  tripwire lifecycle through the shipped bundle in separate processes; and the day-one replay's
  `{notes: 9, trips: 1, silent_allow: 21, silent_local_destructive: 1}` as an inline snapshot.

### Fixed

- `scanBash` had no notion of a `#` comment, so an affirmation marker left in place would have
  become tokens and changed verdicts. The marker is now stripped before tokenizing, and the
  verification ledger strips it too: `npm test # jev:intended …` still counts as a test run.

## [0.2.1] - 2026-09-17

### Changed
- `jev_rank` description now recommends `unit: "file"` for "where is X" questions. Live use showed
  a file's header comment outranking the code it describes, so file-level ranking is the reliable
  way to pick the file; read it afterwards.

## [0.2.0] - 2026-09-17

### Added

- `jev_rank` accepts `paths` or `glob` in place of `candidates` and reads the files itself: rows
  come back as `path:start_line-end_line` plus relevance, never the text that was scored. New
  `unit: "chunk" | "file"` (default `chunk`) controls whether a file source is scored per chunk or
  per file. New output fields `files_scanned`, `chunks_scored`, `skipped`, `est_cost_usd`.
- `jev_verify` accepts `evidence_path` (with optional `start_line`/`end_line`) in place of
  `evidence`. Evidence too large for one request is chunked and every claim is checked against
  every chunk, then merged: the chunk with the strongest verdict wins, and a claim that is firmly
  supported in one chunk and firmly contradicted in another comes back with a new `conflicting`
  verdict. Claims sourced from a file or from a chunked evidence blob carry a `where` line range.
- A shared file-access layer, `src/files/`, used by the MCP tools only. It resolves every path
  with `realpath` and refuses anything outside the project root (so a symlink cannot walk out),
  refuses the same sensitive paths the hook prefilter refuses, skips binaries, files over 512 KB,
  and generated output (`node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `vendor`,
  lockfiles, `*.min.*`), and enforces a hard per-call cost ceiling of 3M estimated input tokens
  (about $0.13): over the ceiling, the call errors with the estimate and nothing is sent.
- A verification ledger. The async `PostToolUse`/`PostToolUseFailure` hooks now record, per
  session, whether the last test/build/type-check/lint command passed and how many edits have
  happened since. The `Stop` check gained a `claims_verified` signal and can now challenge a final
  message that claims checks pass when the last recorded run actually failed; a weaker case
  (claims pass, but nothing was recorded, or edits happened since) is logged as a new
  `unverified-claim` decision without blocking.
- `score_spread` on the `jev_rank` output for every source: top relevance minus median, to two
  decimals. It is the honest measure of whether a ranking discriminated at all — a run scoring
  everything between 0.84 and 0.87 has a spread near zero and an ordering that is noise, however
  confident the top number looks. Below 0.15 the tool description and the skill both say to narrow
  the glob or rephrase the query rather than trust the order. `any_relevant` is unchanged, but its
  schema now records that it is a maximum and therefore biased upward as the candidate set grows.
- `npm run bump -- <version>` keeps `package.json`, `plugin.json`, `marketplace.json`, the lockfile
  and `SERVER_VERSION` in agreement, backed by a test that asserts they never drift apart.
- CI on Node 20 and 22 (`.github/workflows/ci.yml`), `SECURITY.md`, and this changelog.

### Changed

- The Bash prefilter now recognizes a shell command that behaves like an `Edit` — an output
  redirect, `sed -i`, `tee`, or a `cat > file` heredoc whose targets all resolve inside the working
  directory and are not sensitive — and treats it the same way it treats an `Edit`. Ordinary
  in-project edits made through Bash no longer cost a prompt in standard mode.
- New `corroborateUncertain` gate policy option: on in standard mode, off in strict, off by default
  so `jev_gate_action`'s own defaults are unchanged. With it on, an uncertain risk signal
  (destructive, outward-facing, or credential exposure sitting in the uncertain band) only fires
  when something else corroborates it — a wide blast radius, a second risk signal, or a scope
  reading that leans out.
- `jev_rank` caps every request at 16 candidates (`MAX_CANDIDATES_PER_REQUEST`) instead of packing
  each one to the context budget; the budget still applies, whichever binds first. Packing to the
  budget alone put roughly 50 candidates in a call, and at that width the scores stopped
  discriminating: measured live against this repo with the query "where are retries and backoff
  implemented" over 159 file chunks, budget-exact packing (3 requests) scored everything between
  0.84 and 0.87 and left the actual retry implementation out of the top six, while batches of 16
  (10 requests) ranked it first. The payload is sent exactly once either way, so the fix cost 2.5%
  more input tokens and no additional wall-clock time. This applies to `candidates` as well as to
  `paths`/`glob` — that path had the same defect — so a large `candidates` call now reports a
  larger `chunks` count than it did in 0.1.x.

### Fixed

- A glob no longer walks into a directory that resolves outside the project root. It used to
  enumerate the whole linked tree and then refuse each file: a `src/etc -> /etc` symlink produced
  233 entries under it before reporting 233 refusals, and because the 1,000-file cap counts matches
  — and a path outside the root never becomes one — a symlink to `/` or `$HOME` would crawl the
  disk first. The directory is now pruned and counted once as `outside_root`. Two hard caps back it
  up: 20,000 directories and 200,000 entries per glob, each failing with a message that says to
  narrow the pattern.
- A symlink to a directory is no longer reported as a file match. Its own directory entry says
  nothing about its target, and treating it as both meant the reader had to refuse it as "not a
  file"; the walker now stats the target once to classify it.

## [0.1.4] - 2026-09-17

### Fixed

- The plugin manifest mapped `TYPESAFE_API_KEY` to `${user_config.api_key}`. With the plugin
  setting left empty and the key exported in the shell instead, that entry overwrote the inherited
  variable with an empty string, so every MCP tool call failed with "TYPESAFE_API_KEY is not set"
  while the hooks, which read the environment directly, kept working. The manifest now passes the
  setting as `JEV_PLUGIN_API_KEY`, and the server takes the first non-empty value of
  `JEV_PLUGIN_API_KEY`, `CLAUDE_PLUGIN_OPTION_API_KEY`, `TYPESAFE_API_KEY`, in that order, so the
  plugin setting wins when both are present. The missing-key message now names both routes.

## [0.1.3] - 2026-09-17

### Fixed

- Short follow-up prompts ("go", "ship both") no longer evict the request they continue. Substantive
  and short prompts are now capped separately (3 and 2) and kept in order, so an authorization like
  "make it public" is still visible to the gate. Live, a requested push had scored `in_scope` 0.29
  because the recorded window held only "go" and "try it now".
- The request text is now assembled newest-first within its character budget. The previous
  join-then-clamp kept the head of the joined text, which cut off the newest prompt — the
  instruction the user had just given — whenever three long prompts did not all fit.
- `/jev:status` latency figures now count model calls only. Approval records had been carrying
  prompt-to-completion time (including the time the user spent thinking), which put p95 at 32
  seconds against a 1.5 second call timeout.

## [0.1.2] - 2026-09-17

### Added

- `auto_mode` setting (`advise` | `ask`, default `advise`). In auto mode, a confirm-grade judgment
  adds a `[jev]` note to Claude's context and emits no permission decision, leaving the call to
  Claude Code's own auto-mode classifier; block-grade judgments and the hard-coded patterns still
  ask. Abstaining is not approving — the hooks still never emit `allow`.
- `trustRequested` policy option: outward reach and blast radius stop being reasons to ask once
  `in_scope >= review` and neither `destructive` nor `credential_exposure` leans yes, so a push the
  user actually asked for no longer prompts.
- `lenientScope` policy option: an uncertain `in_scope` signal only fires when another risk signal
  or a wide blast radius corroborates it, since Jev reads scope literally and unnamed supporting
  work (installing a dependency) landed in the uncertain band on its own. A firm out-of-scope
  reading still confirms regardless.

Both options are hook-only — on in standard mode, off in strict — and the MCP tool's own defaults
are unchanged; the decision log records them so `/jev:calibrate` can replay the policy exactly.

### Fixed

- Live use showed the standard gate asking about ordinary, requested actions. Verified against the
  live API: a requested push and `npm install` go through silently; an out-of-scope refund, a
  recursive S3 delete, and a force push still ask.

## [0.1.1] - 2026-09-17

### Fixed

- `CLAUDE_PLUGIN_DATA` is exported to hook processes only. The `/jev:*` commands run through the
  Bash tool without it and fell back to `~/.claude/plugins/data/jev`, while the hooks logged to
  `~/.claude/plugins/data/<plugin>-<marketplace>`. `/jev:status`, `/jev:why`, and `/jev:calibrate`
  always showed an empty log, and `/jev:off`/`/jev:on` wrote flags the hooks never read. When the
  variable is unset, the install id is now derived from the script's own path under
  `plugins/cache/<marketplace>/<plugin>/<version>/`; an explicit `CLAUDE_PLUGIN_DATA` still wins,
  and paths outside the plugin cache keep the old default.

## [0.1.0] - 2026-09-17

### Added

- Initial release. Provider-agnostic `DecisionModel` contract (choice/score/probability plus
  batched `evaluate`), with a Jev implementation over TypeSafe's `/v1/systemone` API.
- MCP server with six tools: `jev_evaluate`, `jev_rank`, `jev_verify`, `jev_gate_action`,
  `jev_next_step`, `jev_list_models`. Gating policy lives in code, not in the model.
- A library entry point so a harness can embed the decision layer without going through MCP.
- Claude Code plugin: escalate-only, fail-open hooks — `PreToolUse` gate with a deterministic
  bash/file/MCP prefilter, `PostToolUse` injection screening, `Stop` stop-short check — plus
  `/jev:*` commands, a skill, and a committed, dependency-free `plugin/dist` bundle.

Not yet exercised against the live API at the time of this release.

[0.4.1]: https://github.com/Brainwires/jevwire/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Brainwires/jevwire/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Brainwires/jevwire/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Brainwires/jevwire/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Brainwires/jevwire/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/Brainwires/jevwire/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Brainwires/jevwire/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Brainwires/jevwire/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Brainwires/jevwire/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Brainwires/jevwire/releases/tag/v0.1.0
