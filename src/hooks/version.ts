/**
 * The version the hook bundle reports.
 *
 * `SERVER_VERSION` in `src/server.ts` already carries the release number, but
 * that module imports the MCP SDK, and `hook.mjs` must not. The daemon's
 * `/v1/health` and `daemon.json` both state a version — a client uses it to
 * decide whether the process answering the port is the one it shipped with — so
 * the hook side needs its own constant.
 *
 * `npm run bump` rewrites this line, and `tests/versions.test.ts` fails if it
 * ever disagrees with `package.json`.
 */

export const HOOK_VERSION = "0.6.0";
