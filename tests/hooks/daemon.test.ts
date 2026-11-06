/**
 * The daemon's HTTP surface: who gets in, what gets rejected, and what happens
 * when a handler misbehaves.
 *
 * Every test binds `port: 0`. Nothing in this suite may touch 10522, because
 * that is where a real daemon on the developer's machine lives and a test that
 * killed it — or worse, answered its hooks — would be a test that changed the
 * behaviour of the session running it.
 *
 * The deadline test uses a real 60 ms wall clock rather than fake timers:
 * `node:http` is driven by the real event loop, so freezing time freezes the
 * request too and the test would measure nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionModel, EvaluateResult, Question } from "../../src/decision/types.js";
import { authorize, credentials, expectedKeysFrom, keyFingerprint } from "../../src/hooks/daemon/auth.js";
import { SessionRegistry, sessionConfigOf } from "../../src/hooks/daemon/registry.js";
import { MAX_BODY_BYTES, PROTOCOL, startDaemon, type DaemonHandle } from "../../src/hooks/daemon/server.js";
import type { Deps } from "../../src/hooks/types.js";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const KEY = "sk-test-key";
const NOW = 1_700_000_000_000;

const PRE = {
  session_id: "s1",
  cwd: "/home/dev/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf ~/" },
};

let dir: string;
const handles: DaemonHandle[] = [];

beforeEach(() => {
  dir = tempDir();
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.close();
  }
  cleanup(dir);
});

interface StartOptions {
  expectedKeys?: readonly string[];
  model?: DecisionModel | null;
  depsFor?: (sessionId: string) => Deps;
  sessionKnown?: (sessionId: string) => boolean;
  registry?: SessionRegistry;
  idleMs?: number;
  lastSessionGraceMs?: number;
  wallClockMs?: number;
  onExitRequested?: () => void;
}

async function start(options: StartOptions = {}): Promise<{
  handle: DaemonHandle;
  registry: SessionRegistry;
  deps: Deps;
}> {
  const deps = makeDeps(dir, { model: options.model ?? null, now: NOW });
  const registry = options.registry ?? new SessionRegistry(() => NOW);
  const handle = await startDaemon({
    port: 0,
    expectedKeys: options.expectedKeys === undefined ? [KEY] : options.expectedKeys,
    depsFor: options.depsFor ?? ((): Deps => deps),
    registry,
    onExitRequested: options.onExitRequested ?? ((): void => undefined),
    idleMs: options.idleMs ?? 0,
    lastSessionGraceMs: options.lastSessionGraceMs ?? 0,
    ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
    ...(options.sessionKnown !== undefined ? { sessionKnown: options.sessionKnown } : {}),
  });
  handles.push(handle);
  return { handle, registry, deps };
}

async function hook(
  port: number,
  event: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${KEY}` },
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/hook/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function health(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function waitFor(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for a condition"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

// ------------------------------------------------------------------- health

describe("GET /v1/health", () => {
  it("answers without a credential and identifies itself as jev", async () => {
    const { handle } = await start();
    const body = await health(handle.port);
    expect(body.jev).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(handle.port);
    expect(body.version).toBe(HOOK_VERSION);
    expect(body.protocol).toBe(PROTOCOL);
    expect(body.auth).toBe("key");
    expect(typeof body.started_at).toBe("number");
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.sessions).toBe(0);
    expect(body.counters).toBeDefined();
    expect((body.counters as Record<string, number>).session_auth).toBe(0);
  });

  it("contains no secret of any kind", async () => {
    const { handle } = await start();
    const text = JSON.stringify(await health(handle.port));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("api_key");
  });

  it("says auth none when there is no key anywhere", async () => {
    const { handle } = await start({ expectedKeys: [] });
    const body = await health(handle.port);
    expect(body.auth).toBe("none");
    expect(body.key_fingerprints).toEqual([]);
  });

  it("lists a fingerprint for each key it holds, and still no key itself", async () => {
    const { handle } = await start({ expectedKeys: [KEY, "sk-other-key"] });
    const body = await health(handle.port);
    expect(body.auth).toBe("key");
    expect(body.key_fingerprints).toEqual([KEY, "sk-other-key"].map(keyFingerprint));
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain("sk-other-key");
  });

  it("refuses anything but GET", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

// --------------------------------------------------------------------- auth

describe("authorization", () => {
  it("accepts the bearer form", async () => {
    const { handle } = await start();
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
  });

  it("accepts the env-key header form", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, { "x-jev-env-key": KEY });
    expect(reply.status).toBe(200);
  });

  it("accepts an empty bearer alongside a good env key", async () => {
    // The real shape of an install that set the key in the shell but not in the
    // plugin's options: `Bearer ` with nothing after it, plus the env header.
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, {
      authorization: "Bearer ",
      "x-jev-env-key": KEY,
    });
    expect(reply.status).toBe(200);
  });

  it("accepts any one of the keys it holds, in either header", async () => {
    // The option and the shell can hold different keys, and the hooks
    // interpolate one of each, so either alone has to get in.
    const { handle } = await start({ expectedKeys: ["option-key", "env-key"] });
    expect(
      (await hook(handle.port, "PreToolUse", PRE, { authorization: "Bearer option-key" })).status,
    ).toBe(200);
    expect((await hook(handle.port, "PreToolUse", PRE, { "x-jev-env-key": "env-key" })).status).toBe(200);
    const wrong = await hook(handle.port, "PreToolUse", PRE, { authorization: "Bearer other" });
    expect(wrong.status).toBe(200);
    expect(wrong.text).toBe("{}");
    expect(handle.stats().unauthorized).toBe(1);
  });

  it("answers 200 {} to a wrong key on a hook route, and 401 to the same key on a session route", async () => {
    const { handle } = await start();
    for (const headers of [{ authorization: "Bearer wrong" }, {}, { authorization: "Bearer " }]) {
      const reply = await hook(handle.port, "PreToolUse", PRE, headers);
      // Claude Code shows any non-2xx from an http hook to the user as a hook
      // error, so the refusal is answered in silence and counted instead.
      expect(reply.status, JSON.stringify(headers)).toBe(200);
      expect(reply.text, JSON.stringify(headers)).toBe("{}");
    }
    expect(handle.stats().unauthorized).toBe(3);
    // The session routes keep their real status: `/v1/session/start` uses a
    // 401 from them to recognise a stale daemon.
    const session = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(session.status).toBe(401);
    expect(await session.text()).toBe("{}");
  });

  it("serves everything when no key is configured", async () => {
    const { handle } = await start({ expectedKeys: [] });
    expect((await hook(handle.port, "PreToolUse", PRE, {})).status).toBe(200);
  });

  it("leaves health unauthenticated even with a key set", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/health`);
    expect(response.status).toBe(200);
  });

  it("serves a hook post with no key when the body names a registered session", async () => {
    const { handle } = await start({
      expectedKeys: [KEY],
      sessionKnown: (id: string): boolean => id === "s1",
    });
    const reply = await hook(handle.port, "PreToolUse", PRE, {});
    expect(reply.status).toBe(200);
    expect(handle.stats().hooks.PreToolUse).toBe(1);
    expect(handle.stats().session_auth).toBe(1);
    expect(handle.stats().unauthorized).toBe(0);
  });

  it("refuses a keyless hook post naming an unknown session", async () => {
    const { handle } = await start({
      expectedKeys: [KEY],
      sessionKnown: (id: string): boolean => id === "s1",
    });
    const reply = await hook(handle.port, "PreToolUse", { ...PRE, session_id: "nobody" }, {});
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().hooks.PreToolUse).toBeUndefined();
    expect(handle.stats().unauthorized).toBe(1);
    expect(handle.stats().session_auth).toBe(0);
  });

  it("a known session does not open the session routes", async () => {
    const { handle } = await start({
      expectedKeys: [KEY],
      sessionKnown: (id: string): boolean => id === "s1",
    });
    const startResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(startResp.status).toBe(401);
    const endResp = await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(endResp.status).toBe(401);
  });

  it("an oversize keyless body is refused before any session lookup", async () => {
    let knownCalls = 0;
    const { handle } = await start({
      expectedKeys: [KEY],
      sessionKnown: (id: string): boolean => {
        knownCalls += 1;
        return id === "s1";
      },
    });
    const big = `{"session_id":"s1","pad":"${"a".repeat(MAX_BODY_BYTES + 1024)}"}`;
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    }).catch(() => undefined);
    if (response !== undefined) {
      expect([413, 200]).toContain(response.status);
      if (response.status === 200) expect(await response.text()).toBe("{}");
    }
    await waitFor(() => handle.stats().oversize === 1);
    expect(knownCalls).toBe(0);
  });
});

describe("authorize", () => {
  it("treats an empty bearer as absent rather than as wrong", () => {
    expect(credentials({ authorization: "Bearer " })).toEqual([]);
    expect(credentials({ authorization: "Bearer" })).toEqual([]);
    expect(credentials({ authorization: "Bearer abc" })).toEqual(["abc"]);
    expect(credentials({ "x-jev-env-key": "" })).toEqual([]);
    expect(credentials({ authorization: "bearer abc", "x-jev-env-key": "def" })).toEqual(["abc", "def"]);
  });

  it("compares secrets of different lengths without throwing", () => {
    // `timingSafeEqual` rejects buffers of unequal length, which is why this
    // hashes first. A key one character longer must simply not match.
    expect(authorize({ authorization: "Bearer short" }, ["a-much-longer-key"])).toBe(false);
    expect(authorize({ authorization: `Bearer ${"x".repeat(500)}` }, ["y"])).toBe(false);
  });

  it("accepts anything in unauthenticated mode, including nothing", () => {
    expect(authorize({}, [])).toBe(true);
    expect(authorize({ authorization: "Bearer junk" }, [])).toBe(true);
  });

  it("accepts a credential matching any held key", () => {
    expect(authorize({ authorization: "Bearer one" }, ["one", "two"])).toBe(true);
    expect(authorize({ "x-jev-env-key": "two" }, ["one", "two"])).toBe(true);
    expect(authorize({ authorization: "Bearer three" }, ["one", "two"])).toBe(false);
    expect(authorize({}, ["one", "two"])).toBe(false);
  });

  it("does not leak the key through a fingerprint", () => {
    for (const key of ["abc", KEY]) {
      expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(keyFingerprint("abc")).not.toBe(keyFingerprint("abd"));
  });

  it("reads every key the environment holds, in order, trimmed and de-duplicated", () => {
    expect(expectedKeysFrom({ CLAUDE_PLUGIN_OPTION_API_KEY: " a ", JEV_PLUGIN_API_KEY: "", TYPESAFE_API_KEY: "a" })).toEqual(["a"]);
    expect(expectedKeysFrom({})).toEqual([]);
    expect(expectedKeysFrom({ TYPESAFE_API_KEY: "b", CLAUDE_PLUGIN_OPTION_API_KEY: "a" })).toEqual(["a", "b"]);
    expect(expectedKeysFrom({ JEV_PLUGIN_API_KEY: "j", TYPESAFE_API_KEY: "j" })).toEqual(["j"]);
  });
});

// ------------------------------------------------------------------ routing

describe("routing", () => {
  it("answers 200 {} to an event it has no handler for, and counts it", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "NoSuchEvent", PRE);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().unknown_event).toBe(1);
  });

  it("404s an unknown path", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("200s a GET on a hook route, which is not POST and not a session route", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("has a route for every handler, including the Approval label", async () => {
    const { handle } = await start({ expectedKeys: [] });
    for (const event of [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Approval",
      "UserPromptSubmit",
      "Stop",
      "SubagentStop",
      "SessionStart",
      "SessionEnd",
    ]) {
      const reply = await hook(handle.port, event, { session_id: "s1" }, {});
      expect(reply.status, event).toBe(200);
    }
  });

  it("answers 200 {} to a hook caller on a different protocol, and still 409s one on a session route", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE, {
      authorization: `Bearer ${KEY}`,
      "x-jev-protocol": "99",
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(handle.stats().protocol_mismatch).toBe(1);
    const session = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
        "x-jev-protocol": "99",
      },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(session.status).toBe(409);
  });

  it("accepts the matching protocol, and an absent one", async () => {
    const { handle } = await start();
    expect(
      (await hook(handle.port, "PreToolUse", PRE, {
        authorization: `Bearer ${KEY}`,
        "x-jev-protocol": String(PROTOCOL),
      })).status,
    ).toBe(200);
    expect((await hook(handle.port, "PreToolUse", PRE)).status).toBe(200);
  });

  it("checks the route before authorization, so an unknown hook path is counted as unknown event", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/NoSuchEvent`, {
      method: "POST",
      body: "{}",
    });
    // A hook route answers every refusal `200 {}`; the counter is the record.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
    expect(handle.stats().unknown_event).toBe(1);
    expect(handle.stats().unauthorized).toBe(0);
  });
});

// --------------------------------------------------------------------- body

describe("the request body", () => {
  it("answers `{}` to garbage rather than a 400, which would land in a debug log", async () => {
    const { handle } = await start();
    for (const body of ["", "   ", "not json", "{", "[]", "null", "42", '"a string"', '{"tool_name":']) {
      const reply = await hook(handle.port, "PreToolUse", body);
      expect(reply.status, body).toBe(200);
      expect(reply.text, body).toBe("{}");
    }
    expect(handle.stats().bad_request).toBe(9);
  });

  it("413s a body over 4 MB without buffering it", async () => {
    const { handle } = await start();
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/hook/PreToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: `{"session_id":"s1","pad":"${"a".repeat(MAX_BODY_BYTES + 1024)}"}`,
    }).catch(() => undefined);
    // The daemon answers 413 and destroys the request, so undici may surface
    // either the response or a broken pipe. Either is fail-open; what matters
    // is that the daemon counted it and stayed up.
    if (response !== undefined) expect([413, 200]).toContain(response.status);
    await waitFor(() => handle.stats().oversize === 1);
    expect((await health(handle.port)).jev).toBe(true);
  });

  it("accepts a large but legal body", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: `echo ${"x".repeat(100_000)}` },
    });
    expect(reply.status).toBe(200);
  });
});

// ----------------------------------------------------------------- handlers

describe("serving hooks", () => {
  it("trips a hard pattern with the tripwire text, asking the user by default", async () => {
    const { handle } = await start();
    const reply = await hook(handle.port, "PreToolUse", PRE);
    const parsed = JSON.parse(reply.text) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[jev] tripwire t-");
  });

  it("reports the model stack's counters in health, not just the server's", async () => {
    // The server never calls Jev, so without this the `jev_calls` and
    // `memo_hits` in `/v1/health` would read a confident zero forever.
    const deps = makeDeps(dir, { now: NOW });
    const handle = await startDaemon({
      port: 0,
      expectedKeys: [],
      depsFor: (): Deps => deps,
      registry: new SessionRegistry(() => NOW),
      onExitRequested: () => undefined,
      idleMs: 0,
      lastSessionGraceMs: 0,
      modelStats: () => ({ jev_calls: 9, memo_hits: 4, jev_timeouts: 1, jev_errors: 2 }),
    });
    handles.push(handle);

    const counters = (await health(handle.port)).counters as Record<string, number>;
    expect(counters.jev_calls).toBe(9);
    expect(counters.memo_hits).toBe(4);
    expect(counters.jev_timeouts).toBe(1);
    expect(counters.jev_errors).toBe(2);
    expect(handle.stats().memo_hits).toBe(4);
    // And the server's own counters are not clobbered by the merge.
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } }, {});
    expect(handle.stats().hooks).toEqual({ PreToolUse: 1 });
  });

  it("counts hooks by event", async () => {
    const { handle } = await start();
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
    await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
    await hook(handle.port, "Stop", { session_id: "s1", last_assistant_message: "done" });
    expect(handle.stats().hooks).toEqual({ PreToolUse: 2, Stop: 1 });
  });

  it("answers `{}` and does its bookkeeping afterwards for Approval", async () => {
    const { handle, deps } = await start();
    deps.store.rememberReissue("s1", { tool_use_id: "call-1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    const reply = await hook(handle.port, "Approval", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "call-1",
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    // The reply came first; the log line arrives on a later turn of the loop.
    await waitFor(() => deps.store.readLog().some((r) => r.decision === "reissue-ran"));
  });

  it("answers `{}` when a handler overruns the wall clock, and counts the overrun", async () => {
    const never: DecisionModel = {
      name: "never",
      evaluate: async <Q extends Record<string, Question>>(): Promise<EvaluateResult<Q>> =>
        new Promise<EvaluateResult<Q>>(() => undefined),
      choice: async () => new Promise(() => undefined),
      score: async () => new Promise(() => undefined),
      probability: async () => new Promise(() => undefined),
    };
    const { handle } = await start({ model: never, wallClockMs: 60 });
    const started = Date.now();
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: "curl -X POST https://example.com/pay" },
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("{}");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(handle.stats().deadline_overruns).toBe(1);
  });

  it("survives a handler that throws", async () => {
    const throws: DecisionModel = {
      name: "throws",
      evaluate: async () => {
        throw new Error("boom");
      },
      choice: async () => {
        throw new Error("boom");
      },
      score: async () => {
        throw new Error("boom");
      },
      probability: async () => {
        throw new Error("boom");
      },
    };
    const { handle } = await start({ model: throws });
    // The handler catches its own model errors and fails open, so this is a 200
    // carrying only the user-facing notice rather than a 500 — and the daemon
    // is still up after.
    const reply = await hook(handle.port, "PreToolUse", {
      ...PRE,
      tool_input: { command: "curl -X POST https://example.com/pay" },
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["systemMessage"]);
    expect(body.systemMessage).toContain("could not get a judgment (Error)");
    expect((await health(handle.port)).jev).toBe(true);
  });
});

// ------------------------------------------------------------ session state

describe("per-session configuration", () => {
  it("judges a session with the config it registered, not the daemon's", async () => {
    const registry = new SessionRegistry(() => NOW);
    const own = makeDeps(dir, { now: NOW });
    const { handle } = await start({
      registry,
      depsFor: (sessionId: string): Deps => {
        const entry = registry.get(sessionId);
        if (entry === undefined) return own;
        return { ...own, config: { ...own.config, ...entry.config } };
      },
    });

    // Unregistered: the daemon's own config, gate advisory, so it trips.
    expect((await hook(handle.port, "PreToolUse", PRE)).text).toContain("permissionDecision");

    const gateOff = { ...sessionConfigOf(own.config), gate: "off" as const };
    const start1 = await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1", data_dir: dir, config: gateOff }),
    });
    expect(start1.status).toBe(200);
    expect(registry.get("s1")?.config.gate).toBe("off");
    expect(handle.stats().sessions_started).toBe(1);

    // Registered with the gate off: the same call is silent.
    expect((await hook(handle.port, "PreToolUse", PRE)).text).toBe("{}");
  });

  it("falls back to its own config when the snapshot is nonsense", async () => {
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1", config: { gate: "wide-open", autoThreshold: 99, stopCheck: "yes" } }),
    });
    const entry = registry.get("s1");
    expect(entry?.config.gate).toBe("advisory");
    expect(entry?.config.autoThreshold).toBe(0.85);
    expect(entry?.config.stopCheck).toBe(true);
  });

  it("ends a session on /v1/session/end and on the SessionEnd hook", async () => {
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry });
    const register = async (id: string): Promise<void> => {
      await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ session_id: id, data_dir: dir }),
      });
    };
    await register("s1");
    await register("s2");
    expect(registry.count()).toBe(2);

    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(registry.count()).toBe(1);

    await hook(handle.port, "SessionEnd", { session_id: "s2", hook_event_name: "SessionEnd", reason: "other" });
    expect(registry.count()).toBe(0);
    expect(handle.stats().sessions_ended).toBe(2);
  });
});

// ----------------------------------------------------------------- lifetime

describe("lifetime", () => {
  it("asks to exit after the idle window with no requests", async () => {
    let asked = 0;
    const { handle } = await start({ idleMs: 40, onExitRequested: () => (asked += 1) });
    await waitFor(() => asked > 0);
    expect(asked).toBeGreaterThan(0);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("does not count a health probe as activity", async () => {
    // The MCP watchdog probes health every ten seconds for as long as Claude
    // Code runs. If that reset the idle clock, the daemon would never exit.
    let asked = 0;
    const { handle } = await start({ idleMs: 120, onExitRequested: () => (asked += 1) });
    for (let i = 0; i < 4; i += 1) {
      await health(handle.port);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(asked).toBeGreaterThan(0);
  });

  it("keeps the clock running while hooks arrive", async () => {
    let asked = 0;
    const { handle } = await start({ idleMs: 200, onExitRequested: () => (asked += 1) });
    for (let i = 0; i < 4; i += 1) {
      await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "ls -la" } });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(asked).toBe(0);
  });

  it("arms a grace timer when the last session ends", async () => {
    let asked = 0;
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry, lastSessionGraceMs: 40, onExitRequested: () => (asked += 1) });
    const body = (id: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: id, data_dir: dir }),
    });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s1"));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, body("s1"));
    await waitFor(() => asked > 0);
    expect(asked).toBe(1);
  });

  it("cancels the grace timer when a new session arrives", async () => {
    let asked = 0;
    const registry = new SessionRegistry(() => NOW);
    const { handle } = await start({ registry, lastSessionGraceMs: 120, onExitRequested: () => (asked += 1) });
    const body = (id: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ session_id: id, data_dir: dir }),
    });
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s1"));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/end`, body("s1"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fetch(`http://127.0.0.1:${handle.port}/v1/session/start`, body("s2"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(asked).toBe(0);
  });

  it("frees the port on close, so a replacement can bind it", async () => {
    const { handle } = await start();
    const port = handle.port;
    await handle.close();
    handles.length = 0;
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();

    const again = await startDaemon({
      port,
      expectedKeys: [],
      depsFor: (): Deps => makeDeps(dir, { now: NOW }),
      registry: new SessionRegistry(() => NOW),
      onExitRequested: () => undefined,
      idleMs: 0,
      lastSessionGraceMs: 0,
    });
    handles.push(again);
    expect(again.port).toBe(port);
    expect((await health(port)).jev).toBe(true);
  });

  it("rejects a second daemon on a port already held", async () => {
    const { handle } = await start();
    await expect(
      startDaemon({
        port: handle.port,
        expectedKeys: [],
        depsFor: (): Deps => makeDeps(dir, { now: NOW }),
        registry: new SessionRegistry(() => NOW),
        onExitRequested: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("the model reaches the handlers", () => {
  it("judges through the daemon with the session's model", async () => {
    const model = new FakeModel(() => ({
      destructive: noul(0.99),
      outward_facing: noul(0.02),
      in_scope: noul(0.3),
      credential_exposure: noul(0.01),
      blast_radius: score(1, ["a", "b", "c", "d"], 0.9),
    }));
    const { handle, deps } = await start({ model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["clean up"] }), NOW);
    const reply = await hook(handle.port, "PreToolUse", { ...PRE, tool_input: { command: "npm install" } });
    expect(reply.text).toContain("additionalContext");
    expect(model.calls).toHaveLength(1);
  });
});
