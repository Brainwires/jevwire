---
name: daemon
description: Show, stop or restart jev's loopback judgment daemon — the process the http hooks post to. Use it when /jev:status says the daemon is down, after a plugin update, or to check what it has served.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:daemon [status|stop|restart]

Since 0.4.0 most of jev's hooks are `type: "http"` posts to `127.0.0.1:10522`, served by
one daemon per user per machine. It is the same `hook.mjs` the command hooks run, started
with the `daemon` argument by `SessionStart` and kept alive by a watchdog in jev's MCP
server. Without it the hooks fail open in silence.

Run exactly one of these with the Bash tool, picking the subcommand from the user's
argument and defaulting to `status`, then show the output verbatim. `stop` and `restart`
are a code-rule trip (`jev-self-disable`), because stopping the daemon silences the hooks;
under the default `pattern_trips: ask` the user is asked to approve them, and that is
expected — it is the user's own command:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" daemon-ctl status
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" daemon-ctl stop
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" daemon-ctl restart
```

## Reading the output

**"the state file says running and pid N is alive, but it is not reachable from this
shell"** is the normal, healthy reading. This command runs through the Bash tool, whose
process may be sandboxed away from loopback sockets; the hooks reach the daemon from
Claude Code's own process. Do not tell the user the daemon is down on the strength of
that line — the pid and the heartbeat age are the evidence, and the report says so.

**"PORT CONFLICT"** means something that is not jev answered on the port. The hooks are
inactive and nothing is blocked. The fix is to free the port, or to move the daemon with
`JEV_DAEMON_PORT` *and* edit the URL in the plugin's `hooks/hooks.json` to match, because
a hook URL cannot read an environment variable.

**A heartbeat older than a minute** on a daemon whose pid is alive means it is probably
wedged. `stop` it; the watchdog starts a fresh one within ten seconds.

## Why `restart` does not start anything

It stops the daemon and says so. It deliberately does not spawn a replacement: this
command runs through the Bash tool, and on some platforms that process is sandboxed, so a
daemon started from here would inherit a sandbox that stops it reading the data directory
or reaching the network. jev's MCP server notices within ten seconds and starts one, and
the next session start certainly does. In the meantime the hooks fail open and say
nothing.

Tell the user what the daemon has served — hooks by event, jev calls versus memo hits,
timeouts, restarts — rather than only whether it is up. That is the number that says
whether 0.4.0 is doing its job.
