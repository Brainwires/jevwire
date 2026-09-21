# Security

Security policy for **jevwire** ([Brainwires/jevwire](https://github.com/Brainwires/jevwire)),
published on npm as `jevwire` and installed as the Claude Code plugin `jev`.

## What leaves the machine

When a hook decides Jev needs to judge something, or when an MCP tool is pointed at file content,
this plugin sends data to TypeSafe's API at `api.typesafe.ai`. Concretely:

- **Tool inputs and tool results.** The `PreToolUse` gate sends the tool name and a redacted,
  truncated excerpt of its arguments, as fields rather than as one line. A Bash call's
  `description` is deliberately *not* among them. The `PostToolUse` injection screen sends a
  `WebFetch`/`WebSearch`/MCP tool result in overlapping 16,000-character chunks, one request each:
  since 0.5.0 that is **the whole result** up to about 128,000 characters, where 0.4.x sent only a
  12k head and a 4k tail. Past that cap the first chunk, the last, and evenly spaced middles are
  sent, and the local log records how many chunks there were and how many were judged.
- **Your last few prompts.** Kept in the session file so the gate can judge whether an action is
  in scope, and sent as part of that judgment when a request is known.
- **The task a subagent was given.** When Claude spawns a subagent, the prompt it wrote for that
  subagent is kept in the session file for up to 30 minutes and sent as the request that the
  subagent's own tool calls are judged against — the alternative is judging them against a prompt
  the subagent never saw. It is Claude's own text, not a file and not a tool result, and it is
  redacted and clamped like a user prompt. The spawn itself is never judged: no model call, no
  output.
- **Not the affirmation marker.** When Claude answers a tripwire with `# jev:intended <reason>`, the
  marker is stripped from the action *before* anything is sent, precisely so that text Claude wrote
  cannot move the `in_scope` signal. It is written to the local log and shown by `/jev:why`, and it
  never reaches the API.
- **Claude's final message.** Sent to the `Stop` check so it can tell whether Claude's own message
  claims the work, or verification of it, is finished.
- **File contents — only when you point an MCP tool at them.** `jev_rank` with `paths`/`glob` and
  `jev_verify` with `evidence_path` read files from disk on the caller's behalf and send their
  content (or line-ranged chunks of it) to be scored or checked.
- **The `Stop` claim check (0.6.0)** is the one hook that reads the workspace. When a final message
  names a file, an identifier, or a change, the check reads `git diff HEAD` and asks whether the
  named files exist, through a dedicated hook-safe reader (`src/hooks/workspace.ts`). That reader
  makes the same refusals as the file-access layer — sensitive paths, anything outside the cwd
  resolved through `realpath` (symlinks included), a 512 KB per-file cap — and runs git through
  `execFile` with an argument array (never a shell) and `GIT_EXTERNAL_DIFF`/`GIT_PAGER` stripped, so
  a repository's own config cannot turn a diff into code execution. Only the diff and the extracted
  change sentences reach the model; the deterministic file/identifier checks send nothing.

Everything sent is **redacted before logging and before sending**: values that look like secrets
(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, PEM blocks, long hex or base64 following
`key`/`token`/`secret=`) are masked in both the outbound request and the local log entry. This is a
net, not a guarantee — it catches known shapes, not every secret. Everything sent is also
**size-clamped**: tool-input excerpts are capped at 4,000 characters, a tool result at 8 chunks of
16,000 characters, prompts at 2,000 characters each (last 3 kept), a captured subagent task at
2,000 characters, and the `Stop` check's final message at 6,000 characters (tail). File reads for
`jev_rank`/`jev_verify` are capped
by the file-access layer's own per-file (512 KB) and per-call (3M estimated input tokens, about
$0.13) limits — see below.

## What never leaves

- **Sensitive paths.** Anything matched by the sensitive-path predicate is refused outright, by
  both the hook prefilter and the file-access layer used by `jev_rank`/`jev_verify` — refused even
  when you name the path explicitly. That predicate lives in one place,
  `src/util/sensitive-path.ts`, precisely so the two callers can't drift apart; treat that file as
  the authoritative list. As of this writing it covers `.env*`, `id_rsa*` and other private-key
  basenames, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `credentials`, `authorized_keys`,
  `known_hosts`, shell rc/profile files, `.gitconfig`, key/cert extensions (`.pem`, `.p12`, `.pfx`,
  `.key`, `.keystore`, `.jks`), the `.ssh/`, `.aws/`, `.gnupg/`, `.config/gcloud/`, `.kube/`, and
  `.docker/` directories, `**/.claude/settings*.json` and anything under `.claude/settings/` or
  `.claude/hooks/`, and `.git` internals.
- **Anything outside the project root.** The file-access layer resolves every path with `realpath`
  and refuses anything that resolves outside the project root, so a symlink cannot be used to walk
  a read out of the project.
- **The API key.** Never written to a settings file, never logged, never included in the decision
  log or the session file. `/jev:status` reports only whether a key is configured, never its value.

## The daemon

Since 0.4.0 most hooks are `type: "http"` posts to a daemon this plugin starts, rather than a fresh
process per tool call. That moves a hook payload — a tool name and a redacted excerpt of its
arguments — from a pipe between parent and child onto a TCP socket, so it is worth being precise
about what that does and does not expose.

**It binds loopback only.** `127.0.0.1:10522`. Not a configuration choice you can get wrong: the
bind address is a literal in the code. Nothing outside the machine can reach it, whatever the
firewall says.

**It authenticates with your TypeSafe API key.** Every hook sends it, in either
`Authorization: Bearer` or `X-Jev-Env-Key`, and the daemon accepts a request if one of them matches
**any** of the keys present in its environment at start (`CLAUDE_PLUGIN_OPTION_API_KEY`,
`JEV_PLUGIN_API_KEY`, `TYPESAFE_API_KEY`) — compared with `timingSafeEqual` over sha256 digests, so
the comparison does not leak the key's length or prefix by timing. An empty `Bearer ` counts as no
credential rather than a wrong one, because the plugin option interpolates to an empty string when it
is unset. A refused hook post is answered `200 {}` and counted, never a 4xx — Claude Code shows any
non-2xx from an http hook to the user as a hook error, and the plugin fails open in silence — while
`/v1/health` exposes an 8-hex-character sha256 fingerprint of each held key so `/jev:daemon status`
can say what the daemon accepts without ever printing a key.

A hook post whose headers carry no held key is still served when its body names a session the
daemon knows — one registered by `SessionStart` over an authenticated `/v1/session/start`, or one
with a snapshot in the data directory. A live session id is a capability another process of the same
user could already read from the transcript files, so this keeps the existing threat model (single
user, loopback) rather than widening it; the `/v1/session/*` routes, which change what the daemon
knows, always require the key. `/jev:daemon status` reports how many posts were served this way.

**`/v1/health` is unauthenticated and carries no secret.** It has to be: it is how a starting hook
tells "my daemon, current version" from "my daemon, stale" from "somebody else's server" before it
has anywhere to send a credential. It reports a pid, a port, a version, a protocol number, the
bundle's path and mtime, an uptime, a session count, whether auth is on, and counters. No key, no
session content, no tool arguments. A test asserts the key does not appear in it.

**There is no shutdown endpoint.** Stopping the daemon takes a signal, which takes being the same
user. An HTTP route that could kill the process would be a route worth attacking.

**A keyless install runs it unauthenticated**, and says so: `/v1/health` reports `auth: "none"` and
`/jev:status` prints it. This is a deliberate choice rather than an oversight. Without a key the
daemon cannot call Jev, so there is no spend to incur and no judgment to subvert; the alternative —
inventing a separate secret so a keyless install could authenticate — would add a credential to
manage for no gain. What an unauthenticated daemon will still do is accept a hook payload from any
local process and write it to your decision log.

### Residual risk: port squatting

**A different local user who binds 10522 before the daemon does will receive the hook payloads and
the API key in a request header.** The plugin detects that something is on the port and that it is
not answering as jev — it marks `port-conflict`, tells you at session start, leaves the other process
strictly alone (it never signals a process it cannot identify) and keeps its hooks inactive. But the
detection happens on the *next* session start, and the hooks in a session already running would have
been posting to whatever is there.

Consequently: **multi-user hosts are not supported.** On a machine where you are the only user with
a login, or where nobody untrusted can run code as another local user, the exposure is the same as
any other loopback service. On a shared box, do not use the daemon: set `JEV_DAEMON_DISABLE=1` and
the plugin falls back to a process per hook, which passes the payload over a pipe instead.

A `daemon_secret` setting — a secret minted by the plugin rather than reused from the API key —
would narrow this to "the squatter gets the payloads but not the key", and can be added later without
a protocol change. It does not close it: a squatter is still receiving tool arguments.

### What the daemon keeps in memory

One `JevDecisionModel`, a registry of the sessions that said hello (session id, data directory, and
the non-secret settings snapshot), and a memo of up to 256 recent Jev answers for five minutes, keyed
by a sha256 of the request. The memo holds answers, not request text — but the key is derived from
the request, so an attacker who could already guess an exact payload could confirm the guess by
timing. That is not a meaningful escalation for anyone who can already post to the port.

The memo also means a judgment can be *reused*: the same tool call inside five minutes gets the
earlier answer rather than a fresh one. It is logged as `memo: true` with `latency_ms: 0` and zero
tokens so the log never claims a call that did not happen.

## Where the log lives, and how to delete it

State is written under `${CLAUDE_PLUGIN_DATA}`, which falls back to
`~/.claude/plugins/data/<plugin>@<marketplace>/` when that environment variable is not set. Two
kinds of file live there:

- `decisions.jsonl` — an append-only log, one line per hook invocation that reached a decision or
  an error. Rotated at 5 MB (renamed to `decisions.1.jsonl`, one generation kept). **Two fields are
  new in 0.3.0 and worth knowing about:** `emitted` is the exact text the hook handed Claude (up to
  300 characters, redacted), and `affirmation` is the reason Claude typed into an affirmation marker
  (up to 200 characters, redacted). Both are recorded deliberately — a tripwire that the agent can
  answer is only auditable if the answer is written down — and both are redacted with the same
  secret-shaped-value net as everything else, which means a secret with no recognizable shape typed
  into a marker would land in the log.
- `sessions/<session_id>.json` — per-session bookkeeping: your last few prompts, the verification
  ledger, the block count used to cap `Stop` blocks at one per prompt, open tripwires (each with its
  reason, its signals and any affirmation, expiring after 30 minutes), the tasks Claude handed any
  running subagents (redacted, expiring after 30 minutes), and the note counters used for the
  per-prompt cap and the duplicate check. Pruned opportunistically after about 7 days.

Deleting this directory is safe. It contains no configuration and nothing needed for the plugin to
keep working — the only thing you lose is calibration history (`/jev:calibrate`, `/jev:why`) and
the record of your last few prompts. Run `/jev:status` to print the resolved path before you delete
it, if you want to confirm where it lives on your machine.

## Advisory, not a boundary

jev can add a note, deny a call once, or block a stop — it can never emit
`permissionDecision: "allow"`. That makes it a layer that can make a bad tool call *less likely* to
go through unnoticed. It does not make one *impossible*, and 0.3.0 is explicit about the two reasons
why:

- **A note is post-hoc by construction.** Claude Code delivers a `PreToolUse` `additionalContext`
  next to the tool result — after the call has run — and drops it when the call is blocked. A note
  can only inform what happens next. Only a tripwire (the hard-coded catastrophic patterns and a
  model block-grade judgment) acts before execution.
- **A tripwire is answerable by the agent.** Claude may re-issue the identical call with
  `# jev:intended <reason>` on its last line and it passes the hook. That is the point — nothing
  here prompts you — but it means the plugin stops a mistake, not an adversary. A marker is honoured
  only against a trip this hook wrote for that exact action within 30 minutes, marker text never
  reaches the API, a marker on a call that was never tripped is stripped and counted, and every
  marker is logged and printed by `/jev:why`. Injected text that can persuade the agent to act can
  also persuade it to affirm; the affirmation text in the log is the audit trail, not a defence.

Every hook also fails open on any error (no API key, a timeout, a network error, malformed input, a
bug), because a gate that breaks your session when an API is unreachable is worse than no gate.

Jev is also not injection-hardened. It reads the tool input, tool result excerpt, or file content
you hand it as data, and text designed to argue for its own approval — whether typed by you, present
in a file, or embedded in a fetched page — can move its probabilities. Do not treat a `jev_gate_action`
`allow`, the absence of a note, or a tripwire that was answered, as a security decision.

Real enforcement — the thing that actually stops a tool call — belongs in Claude Code's own
permission rules, not in this plugin.

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory flow:
<https://github.com/Brainwires/jevwire/security/advisories/new>.

Do not open a public issue for anything exploitable. This is a small project maintained on a
best-effort basis, so there is no guaranteed response time — but reports are read, and a fix or an
acknowledgment is the goal for anything that turns out to be real.
