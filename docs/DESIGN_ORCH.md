# jev orchestration integration — design

Status: design, 2026-09-21. Folds fable-lite's orchestration + Ollama execution into the jev plugin as
**one addon that does orchestration + running tasks on Ollama cloud models** (user-confirmed 2026-09-21).
Source: the peer fable-lite session's portable bundle, branch `jev-orchestration-bundle`, under
`jev-orch/` (its `INTEGRATION.md` is the contract this expands). The bundle is de-namespaced and
provider-neutral; this session owns the jev-side wiring and review.

## What it adds, and the invariant that keeps jev jev

jev is a small, security-careful advisory **decision** layer (loopback-only daemon, refusing readers,
no outward mutation, never `allow`). Orchestration is a different concern — it spawns nested
`claude -p` at external endpoints and its guard hooks *block* the Agent tool / edits / Bash to force
delegation. Both new capabilities ship **off by default**, so a jev user who wants only the decision
layer is completely unaffected: with `orchestration` off, all four guard hooks are no-ops.

## The two toggles

`plugin.json` `userConfig`, both `boolean`, default `false`, with env passthrough:

| userConfig | env | on-effect |
|---|---|---|
| `orchestration` | `JEV_ORCHESTRATION` | the guards enforce the plan/audit split: block project-code edits and test/build/code-writing Bash on the premium session, and gate the Agent tool. Off → four no-op hooks. |
| `external_models` | `JEV_EXTERNAL_MODELS` | delegation offloads to the Ollama endpoint via `jev-run`. Off → delegation falls back to normal Anthropic sub-agents (Opus/Sonnet). |

Compose table: `off/any` = plain Claude Code; `on/off` = plan+audit on premium, implement on Anthropic
sub-agents; `on/on` = plan+audit on premium, implement on Ollama. The guards read the flags straight
from the environment jev exports, so userConfig → env passthrough is the whole wiring.

## Toggle persistence — the one open decision

A slash command cannot change `userConfig` (that is `/plugin` config UI only), yet `/jev:orchestration
on|off` and `/jev:models on|off` must flip the toggles. Decision: **a jev-managed state file the guards
also consult.** `guard-common.sh` already reads `JEV_ORCHESTRATION`/`JEV_EXTERNAL_MODELS` from env;
extend it so the effective flag is `env OR the state file`, where the state file is
`~/.claude/jev-orchestration.state.json` (`{"orchestration":true,"external_models":false}`), written by
the slash commands. Precedence: an explicit `off` in the state file wins over an `on` env (so a user can
disable per-session without touching `/plugin`), otherwise `on` from either source enables. `status`
reads both and reports which set it. This keeps the "read from env" contract for the default path and
makes the slash toggles real without a plugin-config round-trip. (Alternative rejected: commands that
only print "flip it in /plugin" — the user asked for working `on|off` commands.)

## Where the bundle lands in the jev tree (merge, do not overwrite)

- `plugin/bin/{jev-run,jev-batch,jev-models,jev-stats}` — new (chmod +x).
- `plugin/scripts/external-{run,batch,models,stats}.sh` — new.
- `plugin/agents/{scout,sonnet-implementer,opus-implementer,verifier}.md` — new (jev had none).
- `plugin/hooks/{guard-common,agent-guard,edit-guard,bash-guard,session-start}.sh` — new (jev's
  `plugin/hooks/` held only `hooks.json`; the advisory logic is in `dist/hook.mjs`).
- `plugin/hooks/hooks.json` — **merged**: add the orchestration `SessionStart` command hook and the
  three `PreToolUse` guard command hooks (matchers `Agent`, `Edit|Write|MultiEdit|NotebookEdit`, `Bash`)
  *alongside* jev's existing http hooks. Both fire; they are orthogonal (a guard blocks to force
  delegation, the advisory hook notes/denies for safety). Off-by-default keeps the guards silent for a
  decision-only user. The bundle's `session-start.sh` is a second SessionStart command hook next to
  jev's daemon-start one — both run.
- `plugin/commands/` — add `plan, build, delegate, external, stats, orchestration, models, config, help`
  next to jev's `status, why, calibrate, off, on, daemon` (no name collisions). Light jev-voice polish
  on the ported prose.
- `plugin/skills/jev-orchestration/` — add next to `jev-decisions/` (no collision).
- `~/.claude/jev-orchestration.json` — the structured routing config (routes/baseUrl/authToken/
  allowedTools), read by the runner and guards. Precedence per INTEGRATION.md; **strip the
  `.fable-lite/config.json` fallback** (`grep TODO(jev-release)` — two places) before release.

## Nested-run isolation — verified id

Each `jev-run` launches a nested `claude -p` with
`--settings '{"enabledPlugins":{"jev@brainwires-jevwire":false},"disableAllHooks":true}'` and
`JEV_ORCH_INNER=1`. The plugin id `jev@brainwires-jevwire` is **correct** (confirmed to the peer), so
`plugin/scripts/external-run.sh` needs no id change.

## Auditor → jev decision tools (jev-side, no MCP change)

The bundle drops fable-lite's lite `auditor` agent. Its replacement is prose in the ported
`build`/`delegate` skills that, after a phase diff, calls the existing jev MCP tools — no new tool:
- **`jev_evaluate`** over the phase: `state = {brief, diff}`, a Score whose levels are the rubric
  ("does not implement the brief / implements with issues / clean correct implementation"), read by
  level-mass; optionally a Noul battery (compiles, tests touched, follows the exemplar).
- **`jev_verify`** to check the agent's report claims against the diff.
Task **routing** stays the code heuristic in `references/routing-rubric.md` — routing is a magnitude
estimate, Jev's System-2 weak area (per the 2026-09-21 audit), so it is not forced onto Jev.

## Sequencing of the port (each a green commit)
1. Copy the bundle files into `plugin/` (bin/scripts/agents/skills, guard `.sh`), chmod the bins.
2. `plugin.json`: the two userConfig booleans + env passthrough; merge `hooks.json`.
3. `guard-common.sh`: the state-file OR-env toggle read; the `/jev:orchestration|models|config` commands
   write/read the state file. Strip the `.fable-lite` fallback.
4. `docs`, README/CHANGELOG (a new "Orchestration" section, opt-in), SKILL cross-link.
5. Validate (`claude plugin validate --strict` — the new commands/agents/skills must pass), a smoke of
   `jev-models`/`jev-run` gated behind the flags, full suite (the guards are shell, not in the TS suite;
   add a small `tests/` check that `hooks.json` stays valid and the guards are executable). Release as a
   minor (e.g. 0.7.0 "orchestration", or 0.6.3 if kept small) — decide at wire-time.

## Risks
- **hooks.json merge**: the guards and the advisory hooks both fire on Agent/Edit/Bash. Verified benign
  (independent), but the merged file must stay valid and the guards must exit 0 when `orchestration` is
  off — a test pins both.
- **New attack surface** (nested `claude -p`, external endpoints, shell guards) is real; both toggles
  default off and the isolation is verified, so a decision-only user carries none of it. Documented in
  SECURITY.md at wire-time.
- **Toggle persistence** via a state file is the one invented piece; kept minimal and read-only-checked.
- The ported command/skill prose is fable-lite's voice; a light polish pass, not a rewrite.
