/**
 * The one predicate that decides whether a path holds something secret.
 *
 * It lives in its own dependency-free module because two callers with opposite
 * constraints need the *same* answer:
 *
 *  - `src/hooks/prefilter.ts`, which is bundled into `hook.mjs` and may not
 *    pull in anything beyond node builtins;
 *  - `src/files/`, which reads files on behalf of the MCP tools and must refuse
 *    to read these even when the caller names one explicitly.
 *
 * Two copies of a security predicate drift, and the copy that drifts is the one
 * that stops refusing. So there is one copy, and it imports nothing.
 *
 * Matching is on basenames and path segments, never on resolved absolute paths,
 * so no `cwd` and no `~` expansion are needed: `~/.ssh/id_rsa`,
 * `/Users/x/.ssh/id_rsa` and `.ssh/id_rsa` all match the same way.
 */

const SENSITIVE_BASENAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^credentials$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^\.(bash|zsh)(rc|_profile|env|profile|_login)$/i,
  /^\.profile$/i,
  /^\.bashrc$/i,
  /^\.zshrc$/i,
  /^\.zshenv$/i,
  /^\.zprofile$/i,
  /^\.bash_profile$/i,
  /^\.bash_login$/i,
  /^\.gitconfig$/i,
];

const SENSITIVE_EXTENSIONS = [/\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.key$/i, /\.keystore$/i, /\.jks$/i];

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", "gcloud", ".kube", ".docker"]);

/** True when reading or writing here is a decision a human should make. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part !== "");
  const base = parts[parts.length - 1] ?? "";

  if (SENSITIVE_BASENAMES.some((pattern) => pattern.test(base))) return true;
  if (SENSITIVE_EXTENSIONS.some((pattern) => pattern.test(base))) return true;
  if (parts.some((part) => SENSITIVE_DIRS.has(part))) return true;
  // Claude Code's own configuration: a hook that lets an agent rewrite the
  // permission rules has defeated itself.
  if (/\/\.claude\/settings[^/]*\.json$/i.test(`/${normalized}`)) return true;
  if (/\/\.claude\/(settings|hooks)\//i.test(`/${normalized}`)) return true;
  // Git internals, but not files tracked in the working tree.
  if (parts.includes(".git")) return true;
  return false;
}
