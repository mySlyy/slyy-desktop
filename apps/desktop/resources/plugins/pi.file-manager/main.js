"use strict";

/**
 * File Manager — PI-Desktop plugin main process
 *
 * Plugin id: pi.file-manager
 * View:      contributes.views[0] → views/index.html (right work panel)
 *
 * Why raw node:fs:
 *   The host's pi.fs.* gateway cannot meet this plugin's core need: manifest.fs
 *   write/delete syntactically forbid whole-tree globs (plugin-sdk fs-policy.ts
 *   isWholeTreePattern), so any narrow scope that passes validation would turn
 *   every "save" into a permission prompt; fs.list /
 *   fs.glob also have entry limits, skip node_modules, hide credential paths, and
 *   offer no create /
 *   rename / move. The official docs acknowledge this boundary: the brokered gate
 *   "cannot constrain direct Node access inside the plugin process"
 *   (docs/spec/05-security/01-security.md).
 *
 * So this plugin carries all security responsibility itself:
 *   (1) Path containment: normalisation + realpath, refusing .. and symlink / junction escapes
 *   (2) Sensitive path deny list: .env* / .ssh / *.pem / .git/** etc. refused for read and write
 *   (3) Atomic writes: temp file → fsync → chmod → rename; an interruption leaves no half-written file
 *   (4) Conflict detection: mtimeMs + size as an optimistic lock; externally changed files are never overwritten silently
 *   (5) Write audit: appended to write-audit.jsonl in the plugin data directory (the host cannot audit this path)
 *   (6) Limits: text preview 2 MiB / images 8 MiB / audio, video and PDF 24 MiB / writes 8 MiB /
 *      3000 entries per directory / paged search (binary previews travel as base64, hence separate limits)
 *   (7) Host open requests: the host can ask the view to open files outside the project (session scratch
 *      directory / attachments,
 *      paths chosen by the host itself). Absolute paths are accepted only when the view sets external: true;
 *      such a path skips root containment (it is outside the root by definition), while the deny list and
 *      realpath checks stay fully enforced.
 *   (8) Project groups (0.5.0): the host can register one project as several local folders (roots). This plugin
 *      accepts **exactly one** root as the containment base at a time, the selected one (remembered in
 *      prefs.projectRoots, keyed by projectId, or by the primary root path without a projectId). The base
 *      is never widened to "the union of the group": switching the base only switches the door; the rules
 *      behind it stay the same.
 *   (9) Git integration (0.7.0): status and diffs come from the real git in the working copy (read-only subcommands
 *      status / diff / rev-parse, see the "git status" section below), never from parsing .git/** ourselves.
 *      Missing git / not a repository / timeout all just mean "no status" and never affect listing or reads/writes.
 *
 * Channels: view window.pluginBridge.invoke("fm.*", payload) → onPanelInvoke.
 *   The host times out forwarded custom channels after 30s (plugin-runtime.ts PLUGIN_PANEL_TIMEOUT_MS),
 *   so every traversal must be paged and never return a whole tree recursively.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { isRemoteWorkspace, invokeRemote } = require("./remote-workspace.js");

// ── Limits ─────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 3000;
/** Max number of projects remembered in prefs.projectRoots; beyond that the least recently used is evicted. */
const MAX_PROJECT_ROOTS = 20;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_SCANNED = 200000;
const SEARCH_BUDGET_MS = 3000;
const MAX_SEARCH_SESSIONS = 4;
const AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * Images / audio / video go to the view as data URIs: the panel is a file:// sandbox page without a filesystem,
 * and relative paths only point at the view itself, so the bytes must travel with the response (base64 adds about 1/3,
 * which is also why these two kinds have their own limits).
 *
 * Only formats Chromium can really decode. TIFF is deliberately absent: the browser cannot show it, and claiming
 * it as an image would only produce a broken picture; falling through to the binary branch and saying "preview
 * not supported" is more honest.
 * SVG goes through <img>, so scripts never run (an image context is read-only rendering, not a document context).
 */
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
]);

const MEDIA_MIME = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
  [".mkv", "video/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/opus"],
  [".weba", "audio/webm"],
]);

// ── Sensitive path deny list (refused for read and write) ─────────────────

const DENY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "_netrc",
]);
const DENY_EXACT_NAMES = new Set([".env"]);
const DENY_NAME_PREFIXES = [".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

/** Extra write refusal: dependency folders are huge and almost never edited by hand. */
const WRITE_DENY_SEGMENTS = new Set(["node_modules"]);

/** Ignore rule file names; with none in the project, no entry is filtered. */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

// ── Module state ───────────────────────────────────────────────────────────

/**
 * The different defaults of mdPreview / csvTable / jsonTree are deliberate:
 * CSV is mostly plain data and you want the table on open; JSON is mostly config such as package.json /
 * tsconfig.json, where you want to edit the text. Either way the switcher flips to the other side in one click.
 */
let dataPath = null;
let prefs = {
  splitRatio: 0.32,
  /** Whether the left file list is collapsed; a host open request forces it collapsed and persists that. */
  treeCollapsed: false,
  showIgnored: false,
  /**
   * Watch external changes and refresh automatically (0.8.0). On by default; the user can switch back to "manual refresh only" at any time.
   * Both the main-process fs.watch and the view's polling follow this preference.
   */
  watchFiles: true,
  mdPreview: false,
  csvTable: true,
  jsonTree: false,
  tablePageSize: 1000,
  /**
   * Memory of "which folder root is shown" in a project group: projectKey → absolute path.
   * projectKey = `p:<projectId>` (when the host gives a projectId) or `r:<primary root path>`;
   * a value is trusted only if it matches a root the host currently gives (otherwise the primary root), at most
   * MAX_PROJECT_ROOTS entries, LRU-evicted by most recent write. See "Project groups and base" below.
   */
  projectRoots: {},
};
const searchSessions = new Map();

// ── Errors ─────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL",
    message: String(error?.message ?? error),
  };
}

// ── Path safety ────────────────────────────────────────────────────────────

/**
 * Whether child lies strictly inside parent (child === parent returns false).
 * On Windows path.relative already compares the common prefix case-insensitively.
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function segmentsOf(relPath) {
  return String(relPath)
    .split("/")
    .filter((part) => part && part !== ".");
}

function isDenied(relPath, mode) {
  for (const segment of segmentsOf(relPath)) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) return true;
    if (DENY_EXACT_NAMES.has(lower)) return true;
    if (DENY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    if (DENY_EXTENSIONS.has(path.extname(lower))) return true;
    if (mode === "write" && WRITE_DENY_SEGMENTS.has(lower)) return true;
  }
  return false;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Current base: the **selected** folder root of the host's group. Every channel resolving relative paths
 * (list / read / write / create / rename / move / search / sqlite) uses it as the containment base.
 *
 * Before 0.5.0 path / name were workspace.path/name; there was only one root, the
 * primary root. With several roots it is now "the selected one". The group identity the view needs is not here, see
 * projectGroup() below: the two are deliberately separate so the view never remembers "the base" as "the group identity".
 */
async function currentRoot() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  if (isRemoteWorkspace(workspace)) throw fail("REMOTE_UNSUPPORTED", "Remote files must use the Host read gateway");
  return rootPayload(workspace, selectedRootOf(workspace));
}

/**
 * Group shape: path / name are the group's **primary root** (identical to pi.workspace.get); projectId
 * and roots pass through to the view unchanged (none when the host gives none). The view learns "which group,
 * which folders" only from here; which one is shown is derived from prefs.projectRoots.
 */
async function projectGroup() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  return rootPayload(workspace, primaryRootOf(rootsOf(workspace)));
}

/** Wrap one root in the shape sent to the view (base path + name + group info). */
function rootPayload(workspace, root) {
  const group = groupRoots(workspace);
  return {
    path: root.path,
    name: root.name,
    ...(workspace.remote ? { remote: workspace.remote } : {}),
    ...(typeof workspace.projectId === "string" && workspace.projectId
      ? { projectId: workspace.projectId }
      : {}),
    ...(group ? { roots: group } : {}),
  };
}

/** Normalise a forward-slash path relative to the root; refuse absolute paths and `..` segments. */
function normalizeRelative(relPath) {
  if (typeof relPath !== "string") throw fail("INVALID_PATH", "path must be a string");
  if (path.isAbsolute(relPath)) throw fail("ABSOLUTE_PATH", "absolute paths are not accepted");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (segmentsOf(rel).some((part) => part === "..")) {
    throw fail("ESCAPE", "path escapes the project root");
  }
  return rel;
}

/**
 * The single entry guard for every channel. Returns { root, rootPath, abs, rel, isRoot }.
 */
async function resolveInsideRoot(relPath, { mode = "read", allowRoot = false } = {}) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;
  const rel = normalizeRelative(relPath);

  if (!rel) {
    if (!allowRoot) throw fail("INVALID_PATH", "the project root is not a valid target here");
    return { root, rootPath, abs: rootPath, rel: "", isRoot: true };
  }

  if (isDenied(rel, mode)) throw fail("DENIED_PATH", `refused path: ${rel}`);

  const abs = path.resolve(rootPath, rel);
  if (!isInside(rootPath, abs)) throw fail("ESCAPE", "path escapes the project root");

  let realRoot;
  try {
    realRoot = await fs.realpath(rootPath);
  } catch {
    realRoot = rootPath;
  }

  // The parent directory must really exist and lie inside the root: this is the main gate against symlink / junction escapes.
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (realParent !== realRoot && !isInside(realRoot, realParent)) {
    throw fail("SYMLINK_ESCAPE", "parent directory resolves outside the project root");
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (realAbs !== realRoot && !isInside(realRoot, realAbs)) {
      throw fail("SYMLINK_ESCAPE", "path resolves outside the project root");
    }
  }

  return { root, rootPath, abs, rel, isRoot: false };
}

/** Absolute path test: POSIX root, Windows drive letter, UNC (`\\server\share`). */
function isAbsolutePath(target) {
  return /^\//.test(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\");
}

/** The deny list splits on POSIX segments, so `\` in external paths is first turned into `/`. */
function denyPathOf(target) {
  return String(target).replace(/\\/g, "/");
}

/**
 * An absolute path outside the project: a file the host asks the view to open (session scratch directory / attachment),
 * chosen by the host itself and outside the project root by definition.
 *
 * The only difference from resolveInsideRoot is the missing root containment check: containment makes no
 * sense for this path. The deny list stays fully enforced, checked on the raw string / normalised form / realpath
 * each, so `..` folding or symlinks cannot hide segments such as .ssh.
 */
async function resolveExternal(rawPath, mode) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw fail("INVALID_PATH", "path must be a non-empty string");
  }
  if (!isAbsolutePath(rawPath)) {
    throw fail("INVALID_PATH", "external mode requires an absolute path");
  }

  const abs = path.resolve(rawPath);
  if (isDenied(denyPathOf(rawPath), mode) || isDenied(denyPathOf(abs), mode)) {
    throw fail("DENIED_PATH", `refused path: ${abs}`);
  }

  // The parent directory must really exist (also when writing a new file), and the real path must not be denied.
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (isDenied(denyPathOf(realParent), mode)) {
    throw fail("DENIED_PATH", `refused path: ${realParent}`);
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (isDenied(denyPathOf(realAbs), mode)) {
      throw fail("DENIED_PATH", `refused path: ${realAbs}`);
    }
  }

  // rel is the absolute path itself: external paths have no root-relative form; the path in the response is it,
  // and the view brings that string back unchanged for reads and writes.
  return { abs, rel: abs };
}

/**
 * Target resolution shared by read / write. Three forms:
 *   payload with `external: true` → absolute path outside the project (a file the host picked itself)
 *   absolute path                 → absolute path under some root of the group (0.5.0, may cross folders)
 *   anything else                 → path relative to "the selected root"
 */
async function resolveTarget(payload, mode) {
  const rawPath = payload?.path ?? "";
  if (payload?.external === true) return resolveExternal(rawPath, mode);
  if (isAbsolutePath(rawPath)) return resolveGroupAbsolute(rawPath, mode);
  return resolveInsideRoot(rawPath, { mode });
}

/**
 * The in-group form of absolute paths: an absolute path from the host may lie in another folder
 * root of the same project. Find the containing root, switch to it, then run the usual guard on the path relative
 * to that root;
 * the absolute path itself is never used as a base, and the containment base is still a single root.
 *
 * Anything outside the group is refused. The only legitimate entry outside the group is a path outside the project
 * that the view marks with `external: true`,
 * which is still handled by resolveExternal.
 */
async function resolveGroupAbsolute(rawPath, mode) {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) throw fail("NO_WORKSPACE", "no project is open");

  const abs = path.resolve(rawPath);
  const roots = rootsOf(workspace);
  const exact = matchRoot(roots, abs);
  const hit = exact ?? roots.find((entry) => isInside(entry.path, abs)) ?? null;
  if (!hit) {
    throw fail("ABSOLUTE_PATH", "absolute paths are only accepted under a registered folder root");
  }

  await selectRoot(workspace, hit.path);
  if (exact) return resolveInsideRoot("", { mode, allowRoot: true });
  return resolveInsideRoot(relativeToRoot(hit.path, abs), { mode });
}

// ── Project groups and base (0.5.0) ────────────────────────────────────────
//
// The host can register one project as several local folders (roots). This plugin uses only "the
// selected root" as the containment base at a time: none of the .. / symlink / credential deny list rules are relaxed,
// only the door changes (never widened to "the union of the group").
//
// Which one is selected: prefs.projectRoots is the **single** source of truth: projectKey → absolute path.
// projectKey is `p:<projectId>` (when the host gives a projectId) or `r:<primary root path>`. The view
// and the main process both derive the base from it, so switching the base must persist this memory before the next channel request.
//
/**
 * Comparison form after stripping trailing separators and turning backslashes into forward slashes.
 *
 * The host reports directories with forward slashes (`C:/Users/me/Docs`), while here (`sanitizePrefs`) Node's
 * `path.resolve()` writes remembered values with backslashes (`C:\Users\me\Docs`). Both spellings of the same
 * directory must count as the same directory, otherwise "remember B after switching" breaks the moment it is written: the view
 * still matches with its raw string (the header name changes), while here nothing matches and we fall back to the primary folder (the list does not change).
 */
function canonicalPath(target) {
  const trimmed = String(target).replace(/[\\/]+$/, "");
  return (trimmed || String(target)).replace(/\\/g, "/");
}

/** Two spellings of the same directory (Windows drive letter / path case, trailing slash). */
function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** Match a root in roots by path: exact first, then once more case-insensitively. */
function matchRoot(roots, target) {
  return (
    roots.find((entry) => entry.path === target) ??
    roots.find((entry) => samePath(entry.path, target)) ??
    null
  );
}

/** POSIX path relative to a root (the caller must already have confirmed it lies inside that root). */
function relativeToRoot(rootPath, abs) {
  return path.relative(rootPath, abs).split(path.sep).join("/");
}

/**
 * Normalised roots from the host; null when the host sent none (or only garbage). Never
 * invent fake roots to fool the view. A missing name falls back to the directory name.
 */
function groupRoots(workspace) {
  const raw = workspace?.roots;
  if (!Array.isArray(raw)) return null;
  const roots = [];
  for (const entry of raw) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    roots.push({
      path: entry.path,
      name:
        typeof entry.name === "string" && entry.name
          ? entry.name
          : path.posix.basename(entry.path.replace(/\\/g, "/")),
      primary: entry.primary === true,
    });
  }
  return roots.length > 0 ? roots : null;
}

/** Internal root list: without roots from the host it degrades to a single root (primary root = workspace.path). */
function rootsOf(workspace) {
  const roots = groupRoots(workspace);
  if (roots) return roots;
  return [
    {
      path: workspace.path,
      name:
        typeof workspace.name === "string" && workspace.name
          ? workspace.name
          : path.posix.basename(workspace.path.replace(/\\/g, "/")),
      primary: true,
    },
  ];
}

function primaryRootOf(roots) {
  return roots.find((entry) => entry.primary === true) ?? roots[0];
}

/** Memory key: projectId first; without one, the primary root path (the prefixes keep the two key kinds from colliding). */
function projectKeyOf(workspace) {
  return typeof workspace.projectId === "string" && workspace.projectId
    ? `p:${workspace.projectId}`
    : `r:${workspace.path}`;
}

/**
 * Remember "which root this project shows": each rewrite moves the entry to the end, and beyond
 * MAX_PROJECT_ROOTS entries the oldest is dropped. JS objects keep string keys in insertion order, so insertion order
 * itself is the most-recently-used order.
 */
function rememberProjectRoot(map, key, value) {
  const next = {};
  for (const [entryKey, entryValue] of Object.entries(map ?? {})) {
    if (entryKey === key || typeof entryValue !== "string") continue;
    next[entryKey] = entryValue;
  }
  next[key] = value;

  const keys = Object.keys(next);
  if (keys.length <= MAX_PROJECT_ROOTS) return next;
  const bounded = {};
  for (const entryKey of keys.slice(keys.length - MAX_PROJECT_ROOTS)) {
    bounded[entryKey] = next[entryKey];
  }
  return bounded;
}

/** A remembered root is trusted only if it matches a root the host currently gives, otherwise the primary root is used. */
function selectedRootOf(workspace) {
  const roots = rootsOf(workspace);
  const remembered = (prefs.projectRoots ?? {})[projectKeyOf(workspace)];
  return (
    (typeof remembered === "string" ? matchRoot(roots, remembered) : null) ?? primaryRootOf(roots)
  );
}

/**
 * Switch the base (used when an absolute path lies in another root of the group). Persisting is required: the view also
 * derives the base from this memory, and without writing it the two would disagree. Returns whether the base really changed.
 */
async function selectRoot(workspace, rootPath) {
  const key = projectKeyOf(workspace);
  const changed = !samePath((prefs.projectRoots ?? {})[key] ?? "", rootPath);
  prefs = { ...prefs, projectRoots: rememberProjectRoot(prefs.projectRoots, key, rootPath) };
  if (changed) dropRootScopedCaches();
  try {
    await pi.plugin.setSettings({ fmPrefs: prefs });
  } catch {
    /* A failed settings write does not affect this request: the in-memory base has already switched */
  }
  return changed;
}

/**
 * Two things cached by relative path must be dropped after switching the base: SQLite handles and search sessions;
 * the same relative path under two roots is not the same file.
 */
function dropRootScopedCaches() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
}

// ── Ignore rules (subset of .gitignore / .ignore semantics) ────────────────
//
// If the project has ignore rule files their rules hide entries; with none, everything is shown.
// Supported subset: blank lines, # comments, ! negation, trailing / for directories only, leading / anchoring, * ? ** globs,
// slash-free patterns matching at any depth. No \ escapes and no [a-z] character classes.

function compileIgnoreLine(rawLine, base) {
  let line = String(rawLine).replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;
  const isAnchored = anchored || line.includes("/");

  let source = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "*") {
      if (line[index + 1] === "*") {
        index += 1;
        if (line[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  const pattern = isAnchored
    ? `^${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;
  return { base, regex: new RegExp(pattern), negated, dirOnly };
}

async function readIgnoreFile(rootPath, relDir) {
  const dirAbs = relDir ? path.join(rootPath, relDir.split("/").join(path.sep)) : rootPath;
  const rules = [];
  for (const name of IGNORE_FILE_NAMES) {
    let text;
    try {
      text = await fs.readFile(path.join(dirAbs, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const rule = compileIgnoreLine(line, relDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** All rules along the root → target directory chain (shallow first, deep last; deeper wins). */
async function rulesForDirectory(rootPath, relDir) {
  const parts = segmentsOf(relDir);
  const chain = [""];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(parts.slice(0, index).join("/"));
  }
  const rules = [];
  for (const base of chain) {
    rules.push(...(await readIgnoreFile(rootPath, base)));
  }
  return rules;
}

/**
 * Match decision. An ignored ancestor ignores everything below it (as in git, negation cannot rescue a file
 * from an excluded directory); otherwise the last matching rule decides.
 */
function matchesRules(relPath, isDirectory, rules) {
  const parts = segmentsOf(relPath);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const target = parts.slice(0, depth).join("/");
    const targetIsDir = depth < parts.length || isDirectory;

    let verdict;
    for (const rule of rules) {
      let local = target;
      if (rule.base) {
        if (!target.startsWith(`${rule.base}/`)) continue;
        local = target.slice(rule.base.length + 1);
      }
      if (!local) continue;
      if (rule.dirOnly && !targetIsDir) continue;
      if (rule.regex.test(local)) verdict = !rule.negated;
    }

    if (verdict === undefined) continue;
    if (verdict) return true;
    if (depth === parts.length) return false;
  }
  return false;
}

// ── Audit ──────────────────────────────────────────────────────────────────

async function audit(entry) {
  if (!dataPath) return;
  const file = path.join(dataPath, "write-audit.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > AUDIT_MAX_BYTES) await fs.writeFile(file, line, "utf8");
    else await fs.appendFile(file, line, "utf8");
  } catch {
    /* An audit failure must not affect the main flow */
  }
}

// ── Git status (0.7.0) ─────────────────────────────────────────────────────
//
// The "modified / added" marks in the file list, and what exactly changed in a single file.
//
// Status does **not** come from parsing .git/** ourselves but from running the real git in the working copy (read-only
// subcommands status / diff / rev-parse). Two reasons:
//   (1) Index formats (v2/v3/v4, extensions, sparse index), working tree state, rename detection,
//      .gitattributes filters and line-ending normalisation would all have to be reimplemented. A home-grown status
//      will sooner or later disagree with git, and "agreeing with git" is the entire value of this feature.
//   (2) The plugin process runs in the minimal environment the host gives it (child-process-env.ts only passes PATH and a
//      few other variables); git is on PATH and can be spawned, so status also follows the user's git version.
//
// Boundaries:
//   · Only read-only subcommands, never a switch that writes the index or touches the network. GIT_OPTIONAL_LOCKS=0 keeps
//     status from grabbing .git/index.lock to refresh the index; GIT_TERMINAL_PROMPT=0 turns any
//     unexpected interaction into an immediate failure instead of hanging the panel.
//   · Every subcommand has a timeout (5s) and an output cap and is killed when exceeded. The panel channel budget is 30s,
//     and a listing adds at most one more 2s result cache layer.
//   · Paths still pass resolveInsideRoot first (root containment + credential deny list); git receives
//     **root-relative** paths with GIT_LITERAL_PATHSPECS=1, so file names containing ":(top)" and the like
//     are never treated as pathspec magic. git is merely asked "how are these files doing".
//   · Missing git / folder is not a repository / timeout / anything unexpected just means "no status":
//     everything degrades to null and never affects listing or reads/writes.
//   · Submodules only report whether the pointer changed (--ignore-submodules=none), never recursing into their working trees.

const GIT_TIMEOUT_MS = 5000;
/** Result cache per root: expanding one folder often triggers several list calls. */
const GIT_SNAPSHOT_TTL_MS = 2000;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
/** The "everything added" view of untracked files is read by us, with its own tighter limit. */
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 20000;
/** Fallbacks when git is not on PATH (on Windows git is often not early on PATH). */
const GIT_FALLBACK_BINARIES = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/opt/local/bin/git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
];

/** Status severity: a folder rollup takes the most notable status in its subtree (conflict > added > deleted > …). */
const GIT_STATUS_RANK = {
  typechange: 1,
  modified: 2,
  renamed: 3,
  deleted: 4,
  added: 5,
  conflicted: 6,
};

let childSpawn = null;
/**
 * Lazily obtain child_process.spawn: if this runtime does not provide it (non-Node host, stripped build),
 * each feature using it degrades silently (git becomes "no status", editor detection "no candidates"),
 * while listing, reading, writing and saving keep working.
 */
function childSpawnFn() {
  if (childSpawn === null) {
    try {
      childSpawn = require("node:child_process").spawn;
    } catch {
      childSpawn = false;
    }
  }
  return childSpawn || null;
}

/** The git executable that was found; null = not tried yet. */
let gitBinary = null;

function runGit(rootPath, binary, args, { maxBytes, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const spawn = childSpawnFn();
  if (!spawn) return Promise.reject(fail("GIT_UNAVAILABLE", "child processes are unavailable"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: rootPath,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Read-only trio: do not grab the index lock, do not start a pager, do not prompt.
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          // Treat pathspec magic in file names as plain characters.
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stderr = "";
    let settled = false;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // close can be held up by pipes inherited by descendants; the deadline must end the wait directly.
      finish(reject, fail("GIT_TIMEOUT", "git command timed out"));
      child.kill("SIGKILL");
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Cut it off when over the cap: nobody in the panel reads 8 MiB of status, and cutting saves memory.
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2048) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      finish(resolve, {
        code: code ?? 0,
        stdout: Buffer.concat(chunks),
        truncated,
        timedOut,
        stderr,
      });
    });
  });
}

/**
 * Run one git command. First try `git` on PATH; on ENOENT try the usual install locations one by one,
 * and remember the hit (once per plugin process).
 */
async function runGitCommand(rootPath, args, options = {}) {
  const candidates = gitBinary ? [gitBinary] : ["git", ...GIT_FALLBACK_BINARIES];
  for (const binary of candidates) {
    let result;
    try {
      result = await runGit(rootPath, binary, args, options);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    gitBinary = binary;
    return result;
  }
  throw fail("GIT_UNAVAILABLE", "git was not found on PATH");
}

/**
 * Parses `git status --porcelain=v1 -z`. Two status columns + a path, NUL-separated; a rename /
 * copy is **two** records: first the "new path" (with the XY columns), followed by a bare record with only the original path.
 */
function parsePorcelainV1(stdout) {
  const records = [];
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    // An empty field is the trailing NUL; too short or no space at index 2 means a bare path (the original path of a rename).
    if (!field || field.length < 4 || field[2] !== " ") continue;
    const x = field[0];
    const y = field[1];
    const renamed = x === "R" || x === "C";
    const origPath = renamed ? fields[index + 1] ?? "" : null;
    if (renamed) index += 1;
    records.push({ x, y, path: field.slice(3), origPath });
  }
  return records;
}

/** Two status columns → one display status + "also in the index" + "brand-new file". */
function classifyRecord(record) {
  const { x, y } = record;
  if (x === "?" || y === "?") return { status: "added", staged: false, untracked: true };
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return { status: "conflicted", staged: true, untracked: false };
  }
  if (x === "R" || x === "C") return { status: "renamed", staged: true, untracked: false };
  if (x === "A") return { status: "added", staged: true, untracked: false };
  if (x === "D") return { status: "deleted", staged: true, untracked: false };
  if (y === "D") return { status: "deleted", staged: false, untracked: false };
  if (x === "T" || y === "T") return { status: "typechange", staged: x === "T", untracked: false };
  if (x === "M" || y === "M") return { status: "modified", staged: x === "M", untracked: false };
  return null;
}

/**
 * Parses `git diff --numstat -z`: each record is `+lines\t-lines\tpath`, binary is `-\t-`.
 * Under -z a rename is `+lines\t-lines\t` (empty path) followed by two bare paths, original first, new second.
 */
function parseNumstat(stdout) {
  const stats = new Map();
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const first = field.indexOf("\t");
    const second = first < 0 ? -1 : field.indexOf("\t", first + 1);
    if (second < 0) continue;
    const added = field.slice(0, first);
    const deleted = field.slice(first + 1, second);
    let filePath = field.slice(second + 1);
    if (!filePath) {
      // Rename: the next two bare paths are (original, new); the counts belong to the new path.
      filePath = fields[index + 2] ?? "";
      index += 2;
      if (!filePath) continue;
    }
    stats.set(filePath, {
      added: added === "-" ? 0 : Number(added) || 0,
      deleted: deleted === "-" ? 0 : Number(deleted) || 0,
      binary: added === "-" && deleted === "-",
    });
  }
  return stats;
}

/**
 * Added/removed lines from HEAD → working tree. One diff covers both "staged + unstaged" layers.
 * Before any commit (unborn HEAD) HEAD does not exist; fall back to the "index" and "working tree"
 * diffs and merge them.
 */
async function gitNumstat(rootPath) {
  const options = { maxBytes: MAX_STATUS_BYTES };
  const head = await runGitCommand(rootPath, ["diff", "--numstat", "-z", "HEAD", "--"], options);
  if (head && head.code === 0) return parseNumstat(head.stdout);
  const [staged, worktree] = await Promise.all([
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--cached", "--"], options),
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--"], options),
  ]);
  const merged = new Map();
  for (const result of [staged, worktree]) {
    if (!result || result.code !== 0) continue;
    for (const [filePath, value] of parseNumstat(result.stdout)) merged.set(filePath, value);
  }
  return merged;
}

/**
 * One snapshot: the status of this working copy relative to the current base root.
 *
 * Keys of files are **root-relative** paths (git reports paths relative to the repository root, and the current base may
 * be a subdirectory of the repository, so the prefix from `rev-parse --show-prefix` is removed first); values are the
 * status and line counts to show for that row. A null snapshot = no usable status here (not a repository / no git / error).
 */
async function buildGitSnapshot(rootPath) {
  const probe = await runGitCommand(rootPath, ["rev-parse", "--show-toplevel", "--show-prefix"], {
    maxBytes: 4096,
  });
  if (!probe || probe.code !== 0) return null;
  const probeLines = probe.stdout.toString("utf8").split("\n");
  if (!probeLines[0]) return null;
  const prefix = (probeLines[1] ?? "").trim();

  const [status, stats, branchResult] = await Promise.all([
    runGitCommand(
      rootPath,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { maxBytes: MAX_STATUS_BYTES },
    ),
    gitNumstat(rootPath),
    runGitCommand(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"], { maxBytes: 4096 }).catch(
      () => null,
    ),
  ]);
  if (!status || status.code !== 0) return null;

  const files = new Map();
  for (const record of parsePorcelainV1(status.stdout)) {
    if (prefix && !record.path.startsWith(prefix)) continue;
    const rel = prefix ? record.path.slice(prefix.length) : record.path;
    if (!rel) continue;
    const classified = classifyRecord(record);
    if (!classified) continue;
    const stat = stats.get(record.path);
    files.set(rel, {
      ...classified,
      added: stat?.added ?? 0,
      deleted: stat?.deleted ?? 0,
      // Untracked files have no numstat (git does not know what they used to look like); the diff view counts their lines.
      binary: Boolean(stat?.binary),
    });
  }

  return {
    rootPath,
    files,
    truncated: status.truncated,
    // Unborn repositories and detached HEAD both report "HEAD", which is not a branch name.
    branch: branchResult?.code === 0 ? branchResult.stdout.toString("utf8").trim() : null,
  };
}

/** rootPath → { at, snapshot }; concurrent requests for the same root share one git run. */
let gitCache = new Map();

/** Invalidate the cache right after this plugin changes files: status must follow this save. */
function invalidateGitSnapshots() {
  gitCache = new Map();
}

async function gitSnapshotFor(rootPath) {
  const cached = gitCache.get(rootPath);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() - cached.at < GIT_SNAPSHOT_TTL_MS) return cached.snapshot;

  const pending = buildGitSnapshot(rootPath)
    // A failed snapshot only means "no status": it must never bring down listing / opening files.
    .catch(() => null)
    .then((snapshot) => {
      gitCache.set(rootPath, { at: Date.now(), snapshot });
      return snapshot;
    });
  gitCache.set(rootPath, { at: cached?.at ?? 0, snapshot: cached?.snapshot ?? null, pending });
  return pending;
}

/**
 * Roll changes in the subtree up onto the direct child directories: listing needs one badge per child directory, and
 * rescanning all changes per directory would freeze the panel (3000 entries × tens of thousands of changes). Each
 * change is assigned only to its **first** path segment, so one pass is enough.
 */
function rollupByChildDirectory(snapshot, rel) {
  const prefix = rel ? `${rel}/` : "";
  const groups = new Map();
  for (const [filePath, info] of snapshot.files) {
    if (prefix && !filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // direct child file: its own row carries the status
    const name = rest.slice(0, slash);
    const current = groups.get(name);
    if (!current) {
      groups.set(name, { ...info, changed: 1 });
      continue;
    }
    current.changed += 1;
    current.added += info.added;
    current.deleted += info.deleted;
    current.staged = current.staged || info.staged;
    current.untracked = current.untracked || info.untracked;
    if ((GIT_STATUS_RANK[info.status] ?? 0) > (GIT_STATUS_RANK[current.status] ?? 0)) {
      current.status = info.status;
    }
  }
  // A folder badge only shows status and total line counts; binary is a single-file detail.
  for (const group of groups.values()) delete group.binary;
  return groups;
}

/** The "how many changes" line in the list response: counts only changes inside the current base root. */
function summarizeGit(snapshot) {
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };
  let total = 0;
  for (const info of snapshot.files.values()) {
    if (info.status in counts) counts[info.status] += 1;
    total += 1;
  }
  return {
    available: true,
    branch: snapshot.branch,
    counts,
    total,
    truncated: snapshot.truncated,
  };
}

/** Ask "does it have changes" when opening a file: with the list collapsed the right side still needs "Changes". */
async function gitInfoFor(abs, rel) {
  if (!rel) return null;
  const root = await currentRoot();
  // Outside the project (session scratch files / attachments picked by the host) there is no root base and no git.
  if (!root || !isInside(root.path, abs)) return null;
  const snapshot = await gitSnapshotFor(root.path);
  return snapshot?.files.get(rel) ?? null;
}

/**
 * unified diff → directly renderable sections. Returns line kinds (add/del/ctx) instead of raw text,
 * so the view does not parse it again and it can be unit-tested here.
 */
function parseUnifiedDiff(text) {
  const meta = [];
  const hunks = [];
  let binary = false;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const rawLines = text.split("\n");
  // git output ends with a newline: the last empty string from split is not a line of content; drop it,
  // otherwise every file would end with an extra "blank context" line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) {
        hunk = null;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: line,
        section: (match[5] ?? "").trim(),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // Before the first hunk is the file header: diff --git / index / mode changes / binary notice.
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      else if (line) meta.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { meta, hunks, binary };
}

/**
 * An untracked file's content is all added, and git gives no diff for it (`--no-index` would need a fake /dev/null,
 * which is not reliable across platforms). Read the file directly and prefix each line, matching git's "new file" semantics.
 */
function untrackedDiff(text, truncated) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(0, MAX_DIFF_LINES);
  return {
    meta: ["--- /dev/null", truncated ? "+++ (truncated new file)" : "+++ (new file)"],
    binary: false,
    hunks: [
      {
        header: `@@ -0,0 +1,${kept.length} @@`,
        section: "",
        oldStart: 0,
        newStart: 1,
        lines: kept.map((line, index) => ({
          type: "add",
          text: line,
          oldLine: null,
          newLine: index + 1,
        })),
      },
    ],
  };
}

/**
 * What exactly changed in a file. For tracked files look at both "index → working tree" and "HEAD → index":
 * if only one has content give only that one, if both do list both (with headings saying where each comes from).
 */
async function handleGitDiff(payload) {
  // One resolution is enough: containment, the credential deny list and the base are all in resolveInsideRoot.
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "");
  if (!rel) throw fail("INVALID_PATH", "the project root has no changes to show");
  const snapshot = await gitSnapshotFor(rootPath);
  if (!snapshot) throw fail("GIT_UNAVAILABLE", "git status is unavailable in this folder");

  const info = snapshot.files.get(rel) ?? null;

  if (info?.untracked) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw fail("NOT_FOUND", "file not found");
    if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
      return {
        ok: true,
        path: rel,
        kind: "tooLarge",
        untracked: true,
        limit: MAX_UNTRACKED_DIFF_BYTES,
        size: stat.size,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: true,
      };
    }
    const buffer = await fs.readFile(abs);
    // Contains NUL bytes = binary: prefixing each line is meaningless, say so directly.
    if (buffer.subarray(0, 4096).includes(0)) {
      return {
        ok: true,
        path: rel,
        kind: "binary",
        untracked: true,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: false,
      };
    }
    const parsed = untrackedDiff(buffer.toString("utf8"), buffer.length >= MAX_UNTRACKED_DIFF_BYTES);
    return {
      ok: true,
      path: rel,
      kind: "text",
      untracked: true,
      addedLines: parsed.hunks[0].lines.length,
      deletedLines: 0,
      sections: [{ scope: "worktree", ...parsed }],
      truncated: buffer.length >= MAX_UNTRACKED_DIFF_BYTES,
    };
  }

  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-U3", "--", rel];
  const [worktree, staged] = await Promise.all([
    runGitCommand(rootPath, diffArgs, { maxBytes: MAX_DIFF_BYTES }),
    runGitCommand(
      rootPath,
      ["diff", "--no-color", "--no-ext-diff", "-U3", "--cached", "--", rel],
      { maxBytes: MAX_DIFF_BYTES },
    ),
  ]);
  if (!worktree || worktree.code !== 0) {
    throw fail("GIT_UNAVAILABLE", worktree?.stderr?.trim() || "git diff failed");
  }

  const sections = [];
  let addedLines = 0;
  let deletedLines = 0;
  // Line budget for the whole response: beyond it drop the remaining hunks and say "truncated"; the UI's
  // "output truncated" must be accurate, otherwise users would think that is the whole diff.
  let budget = MAX_DIFF_LINES;
  let truncated = false;

  for (const [scope, result] of [
    ["worktree", worktree],
    ["staged", staged],
  ]) {
    if (!result || result.code !== 0 || result.stdout.length === 0) continue;
    const parsed = parseUnifiedDiff(result.stdout.toString("utf8"));
    if (parsed.hunks.length === 0 && !parsed.binary) continue;

    if (parsed.binary) {
      sections.push({ scope, meta: parsed.meta, hunks: [], binary: true, truncated: false });
      continue;
    }

    const hunks = [];
    for (const hunk of parsed.hunks) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      if (lines.length < hunk.lines.length) truncated = true;
      for (const line of lines) {
        if (line.type === "add") addedLines += 1;
        else if (line.type === "del") deletedLines += 1;
      }
      hunks.push({ ...hunk, lines });
    }
    sections.push({
      scope,
      meta: parsed.meta,
      hunks,
      binary: false,
      truncated: truncated || result.truncated,
    });
  }

  return {
    ok: true,
    path: rel,
    kind:
      sections.length === 0
        ? "none"
        : sections.some((section) => section.binary)
          ? "binary"
          : "text",
    untracked: false,
    status: info,
    addedLines,
    deletedLines,
    sections,
    truncated,
  };
}

// ── File watching (0.8.0) ──────────────────────────────────────────────────
//
// "A file changed outside the editor" used to rely on the user pressing refresh. Now the main process uses Node's
// fs.watch on the **current base root** (recursive), debounces changes into a list of root-relative paths, and the view
// polls them at a low rate. Why "main-process watch + view polling" and not another shape:
//   · The host gives plugins no channel to push to a view (pi only has one-way notifications such as ui.showToast /
//     notify), so the view has to fetch; the main process watches and the view only fetches cursor deltas,
//     instead of the view stat-ing the whole tree every second.
//   · fs.watch is the OS's native notification (macOS FSEvents / Windows
//     ReadDirectoryChangesW / Linux inotify), much cheaper than polling and outside the channel budget.
//
// Three things that must be right:
//   (1) **Never treat our own writes as external changes**: saving is "temp file + rename", which the watcher always
//     reports. Taking that at face value would reload the user's document on every Ctrl+S (losing cursor
//     and scroll position). So every write / create / rename / move / delete by this plugin is noted first
//     (noteSelfWrite), and events arriving within SELF_WRITE_SUPPRESS_MS of that note are dropped.
//   (2) **Ignore noise**: .git/ and node_modules/ change a lot and do not concern this view; credential paths
//     (.env* / .ssh / *.pem…) are still never reported: watching is not a back door around the deny list.
//   (3) **Lose no events, grow without bound never**: events within the debounce window merge into one; the delta history is bounded,
//     and a view returning with a very old cursor only gets "the recent ones" and refreshes conservatively,
//     so missing one round never causes an error.

const WATCH_DEBOUNCE_MS = 250;
const WATCH_HISTORY_LIMIT = 400;
/** Same-path events arriving within this time after our own write are ignored. */
const SELF_WRITE_SUPPRESS_MS = 1500;
const WATCH_SELF_WRITE_CACHE_LIMIT = 200;
/** Max changes reported per poll (beyond that, the view's "refresh the containing folder" already covers it). */
const WATCH_MAX_CHANGED = 200;

let watchSupported = true;
let watcher = null;
let watchRevision = 0;
/** Delta history: { revision, path }; the oldest are dropped beyond the limit. */
let watchHistory = [];
/** Events received within the debounce window (paths de-duplicated). */
let watchPending = new Set();
let watchTimer = null;
/** Root-relative path → timestamp of this plugin's own write to it. */
const selfWrites = new Map();

let fsWatch = null;
/**
 * Lazily obtain fs.watch: if this runtime does not provide it (non-Node host, stripped build), the feature silently
 * degrades to "manual refresh only", the same kind of degradation as missing git.
 */
function fsWatchFn() {
  if (fsWatch === null) {
    try {
      fsWatch = require("node:fs").watch;
    } catch {
      fsWatch = false;
    }
  }
  return fsWatch || null;
}

/** Noise and things we must not watch: .git / node_modules / credential paths / this plugin's temp files. */
function isWatchIgnored(rel) {
  if (!rel) return false;
  // Skip .git / node_modules at any depth (checking only the first segment would miss nested dependency folders).
  if (rel.split("/").some((segment) => segment === ".git" || segment === "node_modules")) return true;
  // Atomic-write temp files: `.README.md.1730abcd.ef12.tmp` (see atomicWrite).
  if (/^\..+\.[a-z0-9]+\.[a-z0-9]+\.tmp$/i.test(rel.split("/").pop() ?? "")) return true;
  return isDenied(rel, "read");
}

/** Was this path just written by this plugin itself? */
function isSelfWrite(rel) {
  const at = selfWrites.get(rel);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_SUPPRESS_MS) {
    selfWrites.delete(rel);
    return false;
  }
  return true;
}

/**
 * This plugin touched this path: events it causes during the next short period are not "external changes".
 *
 * Besides the path itself, record **every ancestor directory** too: when we write a file, the recursive watcher on
 * Windows additionally reports `change <dir>` once for "every directory level containing it"; a file name is given,
 * it is just a directory instead of the file (tested: writing `src/deep/x.ts` reports `change src/deep` and
 * `change src`). Without recording those, a single Ctrl+S would have these extra directory events judged
 * "external changes" and the just-saved document reloaded, exactly what this section prevents. The root itself
 * emits no such directory event (tested), so recording stops at the outermost directory.
 */
function noteSelfWrite(rel) {
  if (!rel) return;
  const stamp = Date.now();
  selfWrites.set(rel, stamp);
  for (let cut = rel.lastIndexOf("/"); cut > 0; cut = rel.lastIndexOf("/", cut - 1)) {
    selfWrites.set(rel.slice(0, cut), stamp);
  }
  if (selfWrites.size > WATCH_SELF_WRITE_CACHE_LIMIT) {
    const now = Date.now();
    for (const [key, at] of selfWrites) {
      if (now - at > SELF_WRITE_SUPPRESS_MS) selfWrites.delete(key);
    }
  }
}

function flushWatchChanges() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchPending.size === 0) return;
  const batch = [...watchPending];
  watchPending = new Set();
  for (const rel of batch) {
    if (isSelfWrite(rel)) continue;
    watchRevision += 1;
    watchHistory.push({ revision: watchRevision, path: rel });
  }
  if (watchHistory.length > WATCH_HISTORY_LIMIT) {
    watchHistory = watchHistory.slice(-WATCH_HISTORY_LIMIT);
  }
  // The disk changed, so git status and line counts changed too: invalidate the snapshot now; the next list / diff recomputes.
  invalidateGitSnapshots();
}

function noteWatchChange(rel) {
  watchPending.add(rel);
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(flushWatchChanges, WATCH_DEBOUNCE_MS);
}

function stopWatching() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  watchPending = new Set();
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* Already closed */
    }
    watcher = null;
  }
}

/** Open one recursive watcher on the base root. Only one at a time: switching the base switches what is watched. */
function startWatching(rootPath) {
  if (watcher?.rootPath === rootPath) return true;
  stopWatching();
  const watch = fsWatchFn();
  if (!watch) {
    watchSupported = false;
    return false;
  }
  try {
    const handle = watch(
      rootPath,
      // persistent: false: watching must not keep the plugin process alive; without changes it may exit naturally.
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        // Some platforms give no file name: then we only know "something under the root changed", so report the root itself
        // and let the view refresh the current folder; better one refresh too many than one missed.
        if (!filename) {
          noteWatchChange("");
          return;
        }
        const rel = String(filename).replace(/\\/g, "/");
        if (isWatchIgnored(rel)) return;
        noteWatchChange(rel);
      },
    );
    handle.on("error", () => {
      // The watcher itself failed (e.g. the root was deleted): fall back to manual refresh and throw to no channel.
      stopWatching();
      watchSupported = false;
    });
    watcher = { rootPath, close: () => handle.close() };
    return true;
  } catch {
    // Old platforms without recursive watch: do not pretend it works; let the view switch auto-refresh off.
    watchSupported = false;
    return false;
  }
}

/**
 * The view's poll: fetch "which paths changed since the last cursor".
 *
 * Also does two things: switch the watcher when the base changed, and flush the batch now when the debounce window is
 * about to expire (otherwise the user would wait one more debounce period for the refresh).
 */
async function handleWatch(payload) {
  const root = await currentRoot();
  if (!root) return { ok: true, available: false, revision: watchRevision, changed: [] };

  if (watchSupported) startWatching(root.path);
  flushWatchChanges();

  const since = Number.isFinite(payload?.since) ? Number(payload.since) : 0;
  const changed = watchHistory
    .filter((entry) => entry.revision > since)
    .map((entry) => entry.path);

  return {
    ok: true,
    available: watchSupported && watcher !== null,
    revision: watchRevision,
    changed: changed.slice(0, WATCH_MAX_CHANGED),
    // The cursor has fallen outside the bounded history: the view should also refresh conservatively, "there may be other changes".
    stale: since > 0 && watchHistory.length > 0 && since < watchHistory[0].revision,
  };
}

// ── Editor detection and "Open with…" (0.9.0) ───────────────────────────────
//
// The tree's context menu must list editors that **really exist** on this machine. Detection deliberately never walks directories:
//   (1) Registry App Paths (HKLM / WOW6432Node / HKCU): installers almost always leave a
//      `<name>.exe` → absolute path entry there, readable in bulk with one reg query;
//   (2) Registry StartMenuInternet `shell\open\command`: browsers (Chrome / Edge /
//      Firefox / Zen and the like) register only there, and it gives the full executable;
//   (3) Executables on PATH by candidate command name (VS Code / Zed install a bin directory);
//   (4) A few fixed install locations derived from the user's home directory, one stat each.
// All four are O(candidates), with no recursive directory listing: "walk the whole disk to find software" is the
// easiest wrong version of this feature to write, and also the slowest.
//
// Results are cached by **date** for one day in the plugin data directory (editors.json): several PI-Desktop instances
// share one probe, and reopening the menu on the same day does not query the registry again. A failed write only falls back to the
// in-process cache, without affecting the feature; with nothing detected the menu keeps only "Default app"; never
// list an editor that does nothing when clicked.
//
// Only real .exe files count (Windows): .cmd / .bat shims need cmd.exe to run,
// and splicing user project paths into a command line is an unnecessary injection surface. Editors in App Paths and on PATH
// almost always provide a real .exe, so this limit does not miss them.

const EDITOR_CACHE_FILE = "editors.json";
const EDITOR_PROBE_TIMEOUT_MS = 4000;
const EDITOR_PROBE_MAX_BYTES = 512 * 1024;

/** The cache is keyed by "date" (local time zone), not a timestamp: probe once a day. */
function todayStamp() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Lazily obtain synchronous fs (detection only does a few stats; async would just be more verbose). */
let fsSync = null;
function fsSyncFn() {
  if (fsSync === null) {
    try {
      fsSync = require("node:fs");
    } catch {
      fsSync = false;
    }
  }
  return fsSync || null;
}

function isFileSync(target) {
  const sync = fsSyncFn();
  if (!sync || !target) return false;
  try {
    return sync.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * File names tried when looking up a command on PATH, in priority order (pure function, asserted by verify-editors).
 * Only .exe is accepted: see the file header on shims.
 */
function pathLookupOrder(name, platform, pathext) {
  if (platform !== "win32") return [name];
  const extensions = String(pathext || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!extensions.includes(".exe")) extensions.unshift(".exe");
  const ordered = [".exe", ...extensions.filter((entry) => entry !== ".exe")];
  return ordered.map((extension) => `${name}${extension}`);
}

/** PATH directories + candidate file names → first file that really exists (no directory walk, only stats of candidates). */
function findOnPath(name) {
  const dirs = String(process.env.PATH || "")
    .split(PLATFORM === "win32" ? ";" : ":")
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  const names = pathLookupOrder(name, PLATFORM, process.env.PATHEXT);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isFileSync(full)) return full;
    }
  }
  return null;
}

const PLATFORM = process.platform;

/**
 * Common editors and browsers. `appPaths` are registry key names (compared lowercase), `commands` are command names
 * on PATH, `fixed` are fixed install locations derived from the user's home directory. The first hit in that order wins,
 * then one more stat confirms the file still exists (the registry often keeps entries of uninstalled software).
 */
function editorCandidates() {
  if (PLATFORM === "darwin") return macEditorCandidates();
  if (PLATFORM === "win32") return windowsEditorCandidates();
  return linuxEditorCandidates();
}

function windowsEditorCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const programs = process.env.ProgramFiles || "C:\\Program Files";
  const programsX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const inLocal = (...rest) => (local ? [path.join(local, ...rest)] : []);
  const inPrograms = (...rest) => [
    path.join(programs, ...rest),
    path.join(programsX86, ...rest),
  ];

  return [
    {
      id: "vscode",
      label: "Visual Studio Code",
      appPaths: ["code.exe"],
      commands: ["code"],
      fixed: [
        ...inLocal("Programs", "Microsoft VS Code", "Code.exe"),
        ...inPrograms("Microsoft VS Code", "Code.exe"),
      ],
    },
    {
      id: "vscode-insiders",
      label: "Visual Studio Code Insiders",
      appPaths: ["code - insiders.exe"],
      commands: ["code-insiders"],
      fixed: [...inLocal("Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe")],
    },
    {
      id: "cursor",
      label: "Cursor",
      appPaths: ["cursor.exe"],
      commands: ["cursor"],
      fixed: [...inLocal("Programs", "cursor", "Cursor.exe")],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      appPaths: ["windsurf.exe"],
      commands: ["windsurf"],
      fixed: [...inLocal("Programs", "Windsurf", "Windsurf.exe")],
    },
    {
      id: "trae",
      label: "Trae",
      appPaths: ["trae.exe"],
      commands: ["trae"],
      fixed: [...inLocal("Programs", "Trae", "Trae.exe")],
    },
    {
      id: "zed",
      label: "Zed",
      appPaths: ["zed.exe"],
      commands: ["zed"],
      fixed: [...inLocal("Programs", "Zed", "Zed.exe")],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      appPaths: ["sublime_text.exe", "subl.exe"],
      commands: ["subl"],
      fixed: [...inPrograms("Sublime Text", "sublime_text.exe")],
    },
    {
      id: "notepadpp",
      label: "Notepad++",
      appPaths: ["notepad++.exe"],
      commands: ["notepad++"],
      fixed: [...inPrograms("Notepad++", "notepad++.exe")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      appPaths: ["chrome.exe"],
      menus: ["google chrome"],
      commands: ["chrome"],
      fixed: [
        ...inPrograms("Google", "Chrome", "Application", "chrome.exe"),
        ...inLocal("Google", "Chrome", "Application", "chrome.exe"),
      ],
    },
    {
      id: "edge",
      label: "Microsoft Edge",
      kind: "browser",
      appPaths: ["msedge.exe"],
      menus: ["microsoft edge"],
      fixed: [...inPrograms("Microsoft", "Edge", "Application", "msedge.exe")],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      appPaths: ["firefox.exe"],
      menus: ["firefox", "firefox.exe"],
      fixed: [...inPrograms("Mozilla Firefox", "firefox.exe")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      appPaths: ["zen.exe"],
      menus: ["zen", "zen browser", "zen.exe"],
      commands: ["zen"],
      fixed: [
        ...inLocal("Zen", "zen.exe"),
        ...inLocal("Programs", "Zen", "zen.exe"),
        ...inPrograms("Zen Browser", "zen.exe"),
      ],
    },
  ];
}

function macEditorCandidates() {
  const home = process.env.HOME || "";
  const apps = "/Applications";
  return [
    {
      id: "vscode",
      label: "Visual Studio Code",
      commands: ["code", "code-insiders"],
      fixed: [
        path.join(apps, "Visual Studio Code.app", "Contents", "MacOS", "Electron"),
        path.join(home, ".local", "bin", "code"),
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      commands: ["cursor"],
      fixed: [path.join(apps, "Cursor.app", "Contents", "MacOS", "Cursor")],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      commands: ["windsurf"],
      fixed: [path.join(apps, "Windsurf.app", "Contents", "MacOS", "Windsurf")],
    },
    {
      id: "zed",
      label: "Zed",
      commands: ["zed"],
      fixed: [
        path.join(apps, "Zed.app", "Contents", "MacOS", "zed"),
        path.join(home, ".local", "bin", "zed"),
      ],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      commands: ["subl"],
      fixed: [path.join(apps, "Sublime Text.app", "Contents", "SharedSupport", "bin", "subl")],
    },
    {
      id: "nova",
      label: "Nova",
      commands: ["nova"],
      fixed: [path.join(apps, "Nova.app", "Contents", "MacOS", "nova")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      commands: [],
      fixed: [path.join(apps, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      commands: [],
      fixed: [path.join(apps, "Firefox.app", "Contents", "MacOS", "firefox")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      commands: ["zen"],
      fixed: [
        path.join(apps, "Zen.app", "Contents", "MacOS", "zen"),
        path.join(apps, "Zen Browser.app", "Contents", "MacOS", "zen"),
      ],
    },
  ];
}

function linuxEditorCandidates() {
  const home = process.env.HOME || "";
  const bin = "/usr/bin";
  const share = [
    path.join(bin, "code"),
    "/usr/share/code/code",
    "/snap/bin/code",
    path.join(home, ".local", "bin", "code"),
  ];
  return [
    { id: "vscode", label: "Visual Studio Code", commands: ["code"], fixed: share },
    {
      id: "cursor",
      label: "Cursor",
      commands: ["cursor"],
      fixed: [path.join(bin, "cursor"), path.join(home, ".local", "bin", "cursor")],
    },
    {
      id: "zed",
      label: "Zed",
      commands: ["zed"],
      fixed: [path.join(bin, "zed"), "/usr/local/bin/zed", path.join(home, ".local", "bin", "zed")],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      commands: ["subl"],
      fixed: [path.join(bin, "subl"), "/opt/sublime_text/sublime_text"],
    },
    {
      id: "notepadqq",
      label: "Notepadqq",
      commands: ["notepadqq"],
      fixed: [path.join(bin, "notepadqq")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      commands: ["google-chrome", "chromium", "chromium-browser"],
      fixed: [],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      commands: ["firefox"],
      fixed: [path.join(bin, "firefox")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      commands: ["zen"],
      fixed: [path.join(bin, "zen")],
    },
  ];
}

/** `reg query /s` output of registry App Paths → `<name>.exe` (lowercase) → absolute path. */
function parseAppPathsRegistry(text) {
  const found = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^HKEY_[^\r\n]*?\\App Paths\\([^\\]+)$/.exec(line);
    if (head) {
      current = head[1].toLowerCase();
      continue;
    }
    if (!current) continue;
    const value = /^\(Default\)\s+REG_SZ\s+(.+)$/.exec(line);
    if (value && !found.has(current)) found.set(current, value[1].trim());
  }
  return found;
}

/**
 * `reg query /s` output of StartMenuInternet → subkey name (lowercase) → executable path.
 * Only the `shell\open\command` entry counts, with values like `"C:\…\chrome.exe" -- "%1"`.
 */
function parseStartMenuRegistry(text) {
  const found = new Map();
  let current = null;
  let inCommand = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^HKEY_[^\r\n]*?\\StartMenuInternet\\(.+)$/.exec(line);
    if (head) {
      const rest = head[1];
      current = rest.split("\\")[0].toLowerCase();
      inCommand = /\\shell\\open\\command$/i.test(rest);
      continue;
    }
    if (!current || !inCommand) continue;
    const value = /^\(Default\)\s+REG_SZ\s+(.+)$/.exec(line);
    if (!value) continue;
    const executable = executableFromCommand(value[1]);
    if (executable && !found.has(current)) found.set(current, executable);
  }
  return found;
}

/** Strip the executable from a shell command line: `"C:\a b\x.exe" -- "%1"` → `C:\a b\x.exe`. */
function executableFromCommand(command) {
  const trimmed = String(command).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) return trimmed.slice(1, end);
  }
  const match = /^(.*?\.exe)(?:\s|$)/i.exec(trimmed);
  if (match) return match[1].replace(/^"|"$/g, "").trim();
  return null;
}

/** Start a read-only child process and collect its stdout; return an empty string when nothing comes (detection degrades silently). */
function runCapture(command, args, timeoutMs = EDITOR_PROBE_TIMEOUT_MS) {
  const spawn = childSpawnFn();
  if (!spawn) return Promise.resolve("");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* Already exited */
      }
      finish("");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      if (out.length >= EDITOR_PROBE_MAX_BYTES) {
        try {
          child.kill();
        } catch {
          /* Already exited */
        }
        finish(out.slice(0, EDITOR_PROBE_MAX_BYTES));
      }
    });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
  });
}

/** Absolute path of reg.exe (System32 is usually not on the plugin process PATH). */
function regExePath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const native = path.join(systemRoot, "System32", "reg.exe");
  return isFileSync(native) ? native : "reg";
}

const REG_APP_PATH_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];

const REG_START_MENU_KEYS = [
  "HKLM\\SOFTWARE\\Clients\\StartMenuInternet",
  "HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
  "HKCU\\SOFTWARE\\Clients\\StartMenuInternet",
];

/**
 * Detection results from the two registry locations + PATH. Registry queries run in parallel: 6 reg.exe runs together
 * take about one process start in total (about 100ms measured), not their sum.
 * Non-Windows, no reg.exe, unreadable registry: all return empty tables, and detection degrades to PATH + fixed paths.
 */
async function editorSources() {
  const empty = { appPaths: new Map(), menus: new Map() };
  if (PLATFORM !== "win32") return empty;

  const reg = regExePath();
  const outputs = await Promise.all([
    ...REG_APP_PATH_KEYS.map((key) => runCapture(reg, ["query", key, "/s"])),
    ...REG_START_MENU_KEYS.map((key) => runCapture(reg, ["query", key, "/s"])),
  ]);

  const appPaths = new Map();
  for (const text of outputs.slice(0, REG_APP_PATH_KEYS.length)) {
    for (const [key, value] of parseAppPathsRegistry(text)) {
      if (!appPaths.has(key)) appPaths.set(key, value);
    }
  }

  const menus = new Map();
  for (const text of outputs.slice(REG_APP_PATH_KEYS.length)) {
    for (const [key, value] of parseStartMenuRegistry(text)) {
      if (!menus.has(key)) menus.set(key, value);
    }
  }

  return { appPaths, menus };
}

/**
 * Where a candidate is found: registry App Paths → StartMenuInternet → PATH → fixed paths.
 *
 * Both registry key name kinds must also be tried as a **prefix**: browser subkeys under StartMenuInternet often carry a client hash suffix
 * (Firefox is `FIREFOX.EXE-308046b0af4a39cb`, Chromium-based ones `Chrome.HTM…`),
 * so exact matching would find nothing. Prefix matching is only a fallback without an exact hit, and takes the shortest key
 * (`chrome` over `chromehtml`) to avoid matching another program with the same prefix.
 */
function lookupRegistryKey(map, key) {
  const wanted = String(key).toLowerCase();
  const exact = map.get(wanted);
  if (exact) return exact;
  let best = null;
  let bestLength = Infinity;
  for (const [name, value] of map) {
    if (!name.startsWith(wanted)) continue;
    if (name.length < bestLength) {
      best = value;
      bestLength = name.length;
    }
  }
  return best;
}

function locateEditor(candidate, sources) {
  for (const key of candidate.appPaths ?? []) {
    const hit = lookupRegistryKey(sources.appPaths, key);
    if (hit && isFileSync(hit)) return hit;
  }
  for (const key of candidate.menus ?? []) {
    const hit = lookupRegistryKey(sources.menus, key);
    if (hit && isFileSync(hit)) return hit;
  }
  for (const name of candidate.commands ?? []) {
    const hit = findOnPath(name);
    if (hit && isOnlyExtension(hit, ".exe")) return hit;
  }
  for (const fixed of candidate.fixed ?? []) {
    if (isFileSync(fixed)) return fixed;
  }
  return null;
}

/** A PATH hit must be an .exe (Windows); on other platforms the command itself is the executable. */
function isOnlyExtension(target, extension) {
  if (PLATFORM !== "win32") return true;
  return target.toLowerCase().endsWith(extension);
}

/**
 * Full detection once; candidates in table order, de-duplicated, returned as { id, label, kind, command }.
 *
 * kind is "what kind of program this is" (editor / browser), not "can it open this file";
 * the latter depends on the clicked file and is decided by the view by extension (lib/editors.ts). It lives here because
 * only the detection side knows Chrome is a browser: as an id list in the view, adding a browser would need two changes.
 */
async function probeEditors() {
  const sources = await editorSources();
  const found = [];
  const seen = new Set();
  for (const candidate of editorCandidates()) {
    const command = locateEditor(candidate, sources);
    if (!command) continue;
    const key = command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind === "browser" ? "browser" : "editor",
      command,
    });
  }
  return found;
}

/** Cache file shape: { stamp, platform, editors }. Any wrong shape counts as no cache. */
async function readEditorCacheFile(stamp) {
  if (!dataPath) return null;
  try {
    const raw = await fs.readFile(path.join(dataPath, EDITOR_CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.stamp !== stamp || parsed.platform !== PLATFORM) return null;
    if (!Array.isArray(parsed.editors)) return null;
    const editors = parsed.editors
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.label === "string" &&
          typeof entry.command === "string",
      )
      // Old caches (versions before 0.9.0 wrote no kind) count as editors: better one "open in browser" item fewer
      // than misjudging an editor as a browser and dropping it from ordinary files.
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        kind: entry.kind === "browser" ? "browser" : "editor",
        command: entry.command,
      }));
    return { stamp, platform: PLATFORM, editors };
  } catch {
    return null;
  }
}

async function writeEditorCacheFile(value) {
  if (!dataPath) return;
  try {
    await fs.writeFile(
      path.join(dataPath, EDITOR_CACHE_FILE),
      `${JSON.stringify(value)}\n`,
      "utf8",
    );
  } catch {
    /* A failed write only means detecting again next time */
  }
}

/** In-process cache + same-day on-disk cache; concurrent calls share one probe. */
let editorCache = null;
let editorProbe = null;

async function detectEditors() {
  const stamp = todayStamp();
  if (editorCache && editorCache.stamp === stamp) return editorCache;

  if (!editorProbe) {
    editorProbe = (async () => {
      const cached = await readEditorCacheFile(stamp);
      if (cached) return cached;
      const editors = await probeEditors();
      const fresh = { stamp, platform: PLATFORM, editors };
      await writeEditorCacheFile(fresh);
      return fresh;
    })();
  }

  try {
    editorCache = await editorProbe;
  } finally {
    editorProbe = null;
  }
  return editorCache;
}

/**
 * Environment for external editors. The plugin process runs in the minimal environment the host gives it (only PATH / SystemRoot /
 * USERPROFILE and about ten other variables), while editors usually read APPDATA / LOCALAPPDATA at startup to find their
 * configuration and extensions. On Windows these two locations are fixed, so derive them from the home directory;
 * everything else is inherited as is, nothing is faked.
 */
function editorEnv() {
  const env = { ...process.env };
  const home = env.USERPROFILE || env.HOME || "";
  if (home) {
    if (!env.APPDATA) env.APPDATA = path.join(home, "AppData", "Roaming");
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  return env;
}

/**
 * Open an absolute path with the given editor.
 *
 * Uses spawn, not a shell: the editor is an executable and the argument one absolute path, with no need for
 * a command-line layer in between (a shell means an injection surface). detached + stdio ignore + unref: the editor is the user's
 * window and must neither disappear when the panel closes nor hold the plugin process.
 */
function launchEditor(command, target) {
  const spawn = childSpawnFn();
  if (!spawn) throw fail("EDITOR_UNAVAILABLE", "child processes are unavailable");
  let child;
  try {
    child = spawn(command, [target], {
      cwd: path.dirname(target),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: editorEnv(),
    });
  } catch (error) {
    throw fail("EDITOR_UNAVAILABLE", String(error?.message ?? error));
  }
  child.on("error", () => {
    /* An editor that fails to start just does nothing; the panel must not report an error for it */
  });
  child.unref();
}

async function handleEditors() {
  const cache = await detectEditors();
  return {
    ok: true,
    platform: PLATFORM,
    stamp: cache.stamp,
    // Give kind to the view as well: it decides from it whether "this program appears for this file" (see lib/editors.ts).
    editors: cache.editors.map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind })),
  };
}

async function handleOpenWith(payload) {
  if (payload?.external === true) {
    // The editor command is never chosen by the view, only the id; external marks the "path outside the project picked by the host"
    // channel and does not belong here; refuse it explicitly rather than let it through.
    throw fail("INVALID_PATH", "external paths are not accepted here");
  }
  const target = await resolveTarget(payload, "read");
  const cache = await detectEditors();
  const editor = cache.editors.find((entry) => entry.id === payload?.id);
  if (!editor) throw fail("UNKNOWN_EDITOR", "that editor is not available on this machine");

  launchEditor(editor.command, target.abs);
  await audit({ api: "fm.openWith", path: `${editor.id}: ${target.rel}`, result: "ok" });
  return { ok: true, editor: { id: editor.id, label: editor.label, kind: editor.kind } };
}

// ── Read ───────────────────────────────────────────────────────────────────

async function handleList(payload) {
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "", {
    allowRoot: true,
  });

  const rules = await rulesForDirectory(rootPath, rel);

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw fail("NOT_FOUND", "directory not found");
    if (error?.code === "ENOTDIR") throw fail("INVALID_PATH", "not a directory");
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw fail("DENIED_PATH", "permission denied");
    }
    throw error;
  }

  const entries = [];
  let truncated = false;

  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }

    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (isDenied(childRel, "read")) continue;

    const childAbs = path.join(abs, dirent.name);
    const isSymlink = dirent.isSymbolicLink();
    const isDirectory = dirent.isDirectory();

    let size;
    let mtimeMs;
    try {
      const stat = isSymlink ? await fs.lstat(childAbs) : await fs.stat(childAbs);
      mtimeMs = stat.mtimeMs;
      if (!isDirectory) size = stat.size;
    } catch {
      continue;
    }

    let escapes = false;
    if (isSymlink) {
      try {
        const real = await fs.realpath(childAbs);
        escapes = real !== rootPath && !isInside(rootPath, real);
      } catch {
        escapes = true;
      }
    }

    entries.push({
      name: dirent.name,
      path: childRel,
      isDirectory: isDirectory && !isSymlink,
      size,
      mtimeMs,
      ignored: rules.length > 0 && matchesRules(childRel, isDirectory, rules),
      isSymlink,
      outside: escapes,
    });
  }

  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  // git status: the whole working copy is computed once (2s cache); files take their own entry, folders their subtree rollup.
  // Not a repository / no git: snapshot is null and the whole column is null; the tree stays, just without badges.
  const snapshot = await gitSnapshotFor(rootPath);
  const gitGroups = snapshot ? rollupByChildDirectory(snapshot, rel) : new Map();
  for (const entry of entries) {
    entry.git = snapshot
      ? entry.isDirectory
        ? gitGroups.get(entry.name) ?? null
        : snapshot.files.get(entry.path) ?? null
      : null;
  }

  return {
    ok: true,
    path: rel,
    entries,
    truncated,
    ignoreActive: rules.length > 0,
    git: snapshot ? summarizeGit(snapshot) : { available: false },
  };
}

/** base64 joined into a data URI: the view only ever gets a string, never a path. */
function asDataUri(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function handleRead(payload) {
  const { abs, rel } = await resolveTarget(payload, "read");

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");
  // Ask git when opening a file as well: does this file have changes. With the left list collapsed (a host open request
  // collapses it) this row is not in the tree, and the "Changes" entry on the right must not disappear with it.
  const base = {
    path: rel,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    git: await gitInfoFor(abs, rel),
  };
  const extension = path.extname(rel).toLowerCase();

  // Database: the 100-byte header is enough to recognise it, so this branch has **no size limit**:
  // even a .db of hundreds of MB opens instantly here (real fetching goes through fm.sqlite.*, one page at a time).
  // A matching extension with a wrong magic number (e.g. Windows thumbs.db is really an OLE file) continues as an ordinary file.
  if (SQLITE_EXT.test(extension)) {
    const head = await readHead(abs, 100);
    if (isSqliteFile(head)) {
      return {
        ok: true,
        kind: "sqlite",
        available: loadSqlite() !== null,
        info: sqliteInfo(head, stat.size, await exists(`${abs}-wal`), await exists(`${abs}-journal`)),
        ...base,
      };
    }
  }

  // PDF is decided independently of text / binary; PDF.js reports corrupt or encrypted documents clearly.
  // Reuses resolveTarget's root containment, credential deny list and checks for host-designated external files.
  if (extension === ".pdf") {
    if (stat.size > MAX_PDF_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_PDF_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    if (buffer.length > MAX_PDF_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_PDF_BYTES, ...base, size: buffer.length };
    }
    return { ok: true, kind: "pdf", mime: "application/pdf", dataUri: asDataUri("application/pdf", buffer), ...base };
  }

  // Images and audio/video return data URIs: under file:// the view cannot reach project files,
  // so the bytes must travel with the response. Each kind checks its size first, to avoid reading into memory and then refusing.
  const imageMime = IMAGE_MIME.get(extension);
  if (imageMime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_IMAGE_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "image", mime: imageMime, dataUri: asDataUri(imageMime, buffer), ...base };
  }

  const mediaMime = MEDIA_MIME.get(extension);
  if (mediaMime) {
    if (stat.size > MAX_MEDIA_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_MEDIA_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "media", mime: mediaMime, dataUri: asDataUri(mediaMime, buffer), ...base };
  }

  // Every other extension is judged by content: over the limit → tooLarge, contains NUL bytes → binary.
  // Binaries such as zip / apk / exe land here, and the view only says "preview not supported".
  if (stat.size > MAX_READ_BYTES) {
    return { ok: true, kind: "tooLarge", limit: MAX_READ_BYTES, ...base };
  }

  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 4096).includes(0)) return { ok: true, kind: "binary", ...base };

  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = (bom ? buffer.subarray(3) : buffer).toString("utf8");
  const eol = text.includes("\r\n") ? "crlf" : "lf";

  return {
    ok: true,
    kind: "text",
    text: eol === "crlf" ? text.split("\r\n").join("\n") : text,
    eol,
    bom,
    ...base,
  };
}

// ── Write ──────────────────────────────────────────────────────────────────

async function atomicWrite(abs, serialized, mode) {
  const dir = path.dirname(abs);
  const suffix = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${path.basename(abs)}.${suffix}.tmp`);

  let handle = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    // rename replaces the inode, so copy the original permission bits to the temp file first.
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});

    // On Windows antivirus / indexers can cause transient EPERM / EBUSY.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, abs);
        return;
      } catch (error) {
        const transient =
          error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function handleWrite(payload) {
  const { abs, rel } = await resolveTarget(payload, "write");

  const text = typeof payload?.text === "string" ? payload.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
    throw fail("TOO_LARGE", "content exceeds the 8 MiB write limit");
  }

  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  // Optimistic lock: changes made outside the editor are never overwritten silently.
  if (stat && typeof payload?.expectedMtimeMs === "number") {
    const mtimeChanged = Math.abs(stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
    const sizeChanged =
      typeof payload?.expectedSize === "number" && stat.size !== payload.expectedSize;
    if (mtimeChanged || sizeChanged) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "the file changed on disk since it was opened",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    }
  }

  let serialized = text;
  if (payload?.eol === "crlf") serialized = serialized.split("\n").join("\r\n");
  if (payload?.bom) serialized = `\uFEFF${serialized}`;

  await atomicWrite(abs, serialized, stat?.mode ?? null);

  const next = await fs.stat(abs);
  await audit({
    api: "fm.write",
    path: rel,
    bytes: Buffer.byteLength(serialized, "utf8"),
    result: "ok",
  });
  // What was just written is "the working tree's change against HEAD": the status cache must be invalidated now,
  // otherwise the tree badges and the diff on the right would lag by 2s.
  invalidateGitSnapshots();
  // The watcher (0.8.0) reports "temp file + rename" as an external change; note it, so the view does not
  // reload the document because of the user's own Ctrl+S (which would lose cursor and scroll position).
  noteSelfWrite(rel);

  return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
}

// ── Create / rename / move / delete ────────────────────────────────────────

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function assertValidName(rawName) {
  if (typeof rawName !== "string") throw fail("INVALID_NAME", "name is required");
  const name = rawName.trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.endsWith(".") || WINDOWS_RESERVED.test(name)) {
    throw fail("INVALID_NAME", "name must be a valid file or directory name");
  }
  return name;
}

function entryFromStat(name, rel, stat) {
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
    // After create / rename / move this row is brand new: its status is computed by the next list call.
    git: null,
  };
}

async function handleCreate(payload) {
  const parent = await resolveInsideRoot(payload?.parent ?? "", { allowRoot: true });
  const name = assertValidName(payload?.name);

  const childAbs = path.join(parent.abs, name);
  const childRel = parent.rel ? `${parent.rel}/${name}` : name;
  if (isDenied(childRel, "write")) throw fail("DENIED_PATH", `refused path: ${childRel}`);
  if (await exists(childAbs)) throw fail("EXISTS", "an entry with that name already exists");

  const isDirectory = Boolean(payload?.isDirectory);
  if (isDirectory) await fs.mkdir(childAbs);
  else await fs.writeFile(childAbs, "", { flag: "wx" });

  await audit({ api: "fm.create", path: childRel, result: "ok" });
  invalidateGitSnapshots(); // A new file should get its "added" badge right away.
  noteSelfWrite(childRel); // Keep the watcher from treating this as an "external create".
  return { ok: true, entry: entryFromStat(name, childRel, await fs.stat(childAbs)) };
}

async function handleRename(payload) {
  const source = await resolveInsideRoot(payload?.path ?? "", { mode: "write" });
  const name = assertValidName(payload?.newName);

  const parentRel = path.posix.dirname(source.rel);
  const dirPrefix = parentRel === "." ? "" : parentRel;
  const nextRel = dirPrefix ? `${dirPrefix}/${name}` : name;
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);

  const nextAbs = path.join(path.dirname(source.abs), name);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  await fs.rename(source.abs, nextAbs);
  await audit({ api: "fm.rename", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

async function handleMove(payload) {
  const source = await resolveInsideRoot(payload?.from ?? "", { mode: "write" });
  const target = await resolveInsideRoot(payload?.toDir ?? "", { mode: "write", allowRoot: true });

  const targetStat = await fs.stat(target.abs).catch(() => null);
  if (!targetStat?.isDirectory()) throw fail("INVALID_PATH", "the destination is not a directory");
  if (source.abs === target.abs) return { ok: true, entry: null };

  // A directory cannot be moved into its own descendants.
  if (isInside(source.abs, target.abs)) {
    throw fail("INVALID_PATH", "cannot move a directory into itself");
  }

  const name = path.posix.basename(source.rel);
  const nextAbs = path.join(target.abs, name);
  const nextRel = target.rel ? `${target.rel}/${name}` : name;
  if (nextAbs === source.abs) return { ok: true, entry: null };
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  try {
    await fs.rename(source.abs, nextAbs);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    // Across volumes: copy + delete.
    await fs.cp(source.abs, nextAbs, { recursive: true, errorOnExist: true });
    await fs.rm(source.abs, { recursive: true });
  }

  await audit({ api: "fm.move", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

/**
 * Delete a file or directory. Directories are removed recursively as a whole; the view asks for confirmation first.
 *
 * Path limits are identical to write / create / rename / move: resolveTarget(payload, "write")
 * covers the project-relative path, in-group absolute path and external out-of-project path forms, including the credential deny list
 * and the node_modules refusal. The root itself must never be deleted: the context menu on empty space can also reach
 * this point, and an empty rel is the root.
 */
async function handleDelete(payload) {
  const target = await resolveTarget(payload, "write");
  // The root itself must never be deleted: the context menu on empty space can also reach this point.
  if (!target.rel) throw fail("INVALID_PATH", "refusing to delete the project root");

  let stat;
  try {
    stat = await fs.lstat(target.abs);
  } catch {
    throw fail("NOT_FOUND", "entry does not exist");
  }

  await fs.rm(target.abs, { recursive: stat.isDirectory(), force: false });

  await audit({ api: "fm.delete", path: target.rel, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(target.rel);
  return { ok: true };
}

// ── Search (paged + session cursor) ────────────────────────────────────────

function pruneSessions() {
  while (searchSessions.size > MAX_SEARCH_SESSIONS) {
    const oldest = [...searchSessions.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    )[0];
    if (!oldest) return;
    searchSessions.delete(oldest[0]);
  }
}

async function handleSearch(payload) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;

  const query = String(payload?.query ?? "").trim();
  if (!query) return { ok: true, matches: [], nextCursor: null, done: true, scanned: 0 };

  const cursor = typeof payload?.cursor === "string" ? payload.cursor : null;
  const limit = Math.min(Math.max(Number(payload?.limit) || MAX_SEARCH_MATCHES, 1), 200);

  let session = cursor ? searchSessions.get(cursor) : null;
  if (!session) {
    // The stack holds "directory frames", not directory paths: a frame is popped only when fully scanned, otherwise when the limit
    // is hit the directory's remaining entries would be lost forever (paging would miss results).
    session = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      needle: query.toLowerCase(),
      stack: [{ dir: "", entries: null, index: 0, rules: [] }],
      scanned: 0,
    };
    searchSessions.set(session.id, session);
    pruneSessions();
  }

  const matches = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const outOfBudget = () =>
    matches.length >= limit || Date.now() > deadline || session.scanned >= MAX_SEARCH_SCANNED;

  while (session.stack.length > 0) {
    if (outOfBudget()) break;

    const frame = session.stack.pop();
    if (!frame.entries) {
      const absDir = frame.dir
        ? path.join(rootPath, frame.dir.split("/").join(path.sep))
        : rootPath;
      frame.rules = await rulesForDirectory(rootPath, frame.dir);
      try {
        frame.entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        frame.entries = [];
      }
      frame.index = 0;
    }

    // Collect subdirectories first and push them after this frame is done: pushing inside the loop would let the later
    // `pop()` take the just-pushed child frame, rescanning the parent frame again and again (infinite loop).
    const children = [];
    while (frame.index < frame.entries.length) {
      if (outOfBudget()) break;

      const dirent = frame.entries[frame.index];
      frame.index += 1;

      if (dirent.name === ".git") continue;
      const childRel = frame.dir ? `${frame.dir}/${dirent.name}` : dirent.name;
      if (isDenied(childRel, "read")) continue;

      const isDirectory = dirent.isDirectory();
      if (frame.rules.length > 0 && matchesRules(childRel, isDirectory, frame.rules)) continue;

      session.scanned += 1;
      if (isDirectory && !dirent.isSymbolicLink()) {
        children.push({ dir: childRel, entries: null, index: 0, rules: [] });
      }
      if (
        dirent.name.toLowerCase().includes(session.needle) ||
        childRel.toLowerCase().includes(session.needle)
      ) {
        matches.push({ name: dirent.name, path: childRel, isDirectory });
      }
    }

    // Push back unchanged if not fully scanned, to continue next time; release the directory listing only when done.
    if (frame.index < frame.entries.length) session.stack.push(frame);
    else frame.entries = null;

    for (const child of children) session.stack.push(child);
  }

  const done = session.scanned >= MAX_SEARCH_SCANNED || session.stack.length === 0;
  if (done) searchSessions.delete(session.id);

  return {
    ok: true,
    matches,
    nextCursor: done ? null : session.id,
    done,
    scanned: session.scanned,
  };
}

// ── SQLite (read-only browsing + queries) ──────────────────────────────────
//
// Uses Node's built-in node:sqlite. The host is Electron 43 / Node 24, where the module exists (tested),
// so the zero-dependency rule holds, on par with using node:fs.
//
// Why not hand the bytes to the view like images: a .db is easily tens or hundreds of MB and can only be queried in the main process,
// sending one page of rows to the view at a time. This is the only preview type in this plugin that opens "large files".
//
// Read-only is pinned in three layers:
//   (1) opened with { readOnly: true }
//   (2) PRAGMA query_only = 1 right after opening (tested: SQLite refuses both DROP / INSERT,
//      reporting "attempt to write a readonly database")
//   (3) statement allowlist: only SELECT / WITH / VALUES / EXPLAIN and read-only PRAGMA, and only
//      single statements: node:sqlite prepare **accepts** multiple statements (tested: "select 1; select 2"
//      runs only the first without error), so multiple statements must be blocked by us.

const SQLITE_EXT = /\.(?:db|db3|sqlite|sqlite3)$/i;
const SQLITE_MAGIC = "SQLite format 3\u0000";
const SQLITE_MAX_ROWS = 5000;
const SQLITE_MAX_CELL = 4096;
const SQLITE_MAX_SQL = 20000;
const SQLITE_MAX_OFFSET = 100000;
const SQLITE_HANDLE_LIMIT = 2;
const SQLITE_IDLE_MS = 60000;
const ROWID = "rowid";

/** Only these read-only PRAGMAs pass; writing ones (journal_mode with a value, writable_schema etc.) are not allowlisted. */
const READ_ONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
  "page_count",
  "page_size",
  "freelist_count",
  "encoding",
  "schema_version",
  "user_version",
  "compile_options",
  "collation_list",
]);

/** These words are all reserved in SQLite and can only appear as keywords (a column with the same name must be quoted, and quoted segments are skipped),
 *  so finding one means a real write statement, with no false positives. */
const WRITE_VERBS = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "drop",
  "alter",
  "create",
  "attach",
  "detach",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);

/**
 * Extract the statement structure: first keyword, all keywords present, and whether it is multiple statements.
 * Quoted segments ('…' / "…" / `…` / […]) and comments are skipped whole, otherwise semicolons and keywords inside SQL would skew the decision.
 */
function analyzeSql(sql) {
  const keywords = [];
  const length = sql.length;
  let index = 0;
  let multiple = false;

  while (index < length) {
    const char = sql[index];

    if (char === "-" && sql[index + 1] === "-") {
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "[") {
      while (index < length && sql[index] !== "]") index += 1;
      index += 1;
      continue;
    }
    if (char === ";") {
      index += 1;
      // Non-blank content after a semicolon → multiple statements
      if (sql.slice(index).replace(/[\s;]/g, "").length > 0) multiple = true;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      keywords.push(sql.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    index += 1;
  }

  return { head: keywords[0] ?? "", keywords, multiple };
}

function assertReadOnlySql(sql) {
  if (!sql.trim()) throw fail("SQLITE_SQL_EMPTY", "the query is empty");
  if (sql.length > SQLITE_MAX_SQL) throw fail("SQLITE_SQL_TOO_LONG", "the query is too long");

  const { head, keywords, multiple } = analyzeSql(sql);
  if (multiple) throw fail("SQLITE_SQL_MULTIPLE", "only a single statement is allowed");
  if (!head) throw fail("SQLITE_SQL_EMPTY", "the query is empty");

  if (head === "select" || head === "values" || head === "explain") return;

  if (head === "with") {
    // WITH can prefix INSERT/UPDATE/DELETE, so check the whole statement again for write verbs
    if (keywords.some((word) => WRITE_VERBS.has(word))) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", "only read-only statements are allowed");
    }
    return;
  }

  if (head === "pragma") {
    const name = keywords[1] ?? "";
    if (!READ_ONLY_PRAGMAS.has(name)) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", `pragma ${name || "?"} is not on the read-only list`);
    }
    return;
  }

  throw fail("SQLITE_SQL_NOT_READ_ONLY", "only select / with / values / explain are allowed");
}

/** Quote an identifier. Names always come from the schema we read ourselves, but are still escaped once; no exceptions for ourselves. */
function quoteIdent(name) {
  return `"${String(name).split('"').join('""')}"`;
}

let sqliteModule;
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** rel path → { db, mtimeMs, size, usedAt }; mtime + size decide whether a handle is still fresh. */
const sqliteHandles = new Map();

function closeSqliteHandle(rel) {
  const entry = sqliteHandles.get(rel);
  if (!entry) return;
  sqliteHandles.delete(rel);
  try {
    entry.db.close();
  } catch {
    /* If it cannot be closed, so be it; it is released when the process exits */
  }
}

function pruneSqliteHandles() {
  while (sqliteHandles.size > SQLITE_HANDLE_LIMIT) {
    const oldest = [...sqliteHandles.entries()].sort(
      (left, right) => left[1].usedAt - right[1].usedAt,
    )[0];
    if (!oldest) return;
    closeSqliteHandle(oldest[0]);
  }
}

/** Read the file header (100 bytes by default); reading only that much is why even a large .db opens instantly. */
async function readHead(abs, bytes = 100) {
  let handle = null;
  try {
    handle = await fs.open(abs, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const isSqliteFile = (head) =>
  head.length >= 16 && head.subarray(0, 16).toString("latin1") === SQLITE_MAGIC;

/** 100-byte header → overview. Page size is at offset 16 (big-endian u16, value 1 means 65536). */
function sqliteInfo(head, size, hasWal, hasJournal) {
  const u16 = (offset) => head.readUInt16BE(offset);
  const u32 = (offset) => head.readUInt32BE(offset);
  const encoding = u32(56);

  return {
    size,
    pageSize: head.length >= 18 ? (u16(16) === 1 ? 65536 : u16(16)) : 0,
    pageCount: head.length >= 32 ? u32(28) : 0,
    encoding: encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8",
    journalMode: head.length >= 19 && head[18] === 2 ? "wal" : "rollback",
    schemaVersion: head.length >= 44 ? u32(40) : 0,
    libraryVersion: head.length >= 100 ? u32(96) : 0,
    hasWal,
    hasJournal,
  };
}

async function sqliteFileInfo(abs, rel, stat) {
  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) return null;
  const hasWal = await exists(`${abs}-wal`);
  const hasJournal = await exists(`${abs}-journal`);
  return sqliteInfo(head, stat.size, hasWal, hasJournal);
}

/** Get (opening if needed) a read-only handle. Reopen if the file changed externally, so we never see a stale schema. */
async function sqliteHandle(relPath) {
  const { abs, rel } = await resolveInsideRoot(relPath, { mode: "read" });

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) throw fail("NOT_SQLITE", "this file is not a SQLite database");

  const sqlite = loadSqlite();
  if (!sqlite) throw fail("SQLITE_UNAVAILABLE", "this runtime does not provide node:sqlite");

  // Let go after idling too long: the plugin process should not keep holding another program's database file
  const now = Date.now();
  for (const [key, entry] of [...sqliteHandles.entries()]) {
    if (now - entry.usedAt > SQLITE_IDLE_MS) closeSqliteHandle(key);
  }

  const cached = sqliteHandles.get(rel);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.usedAt = Date.now();
    return { db: cached.db, rel, abs, stat };
  }
  if (cached) closeSqliteHandle(rel);

  const db = new sqlite.DatabaseSync(abs, { readOnly: true });
  try {
    db.exec("pragma query_only = 1");
    // SQLite opens lazily: a valid header with corrupt content only fails on the first query.
    // Kick it here, so the failure surfaces at open time.
    db.prepare("select count(*) as n from sqlite_master").get();
  } catch (error) {
    try {
      db.close();
    } catch {
      /* A handle that cannot be opened can only be discarded */
    }
    if (error?.code === "ERR_SQLITE_ERROR") {
      throw fail("SQLITE_BROKEN", `SQLite could not read this file: ${error.message}`);
    }
    throw error;
  }

  sqliteHandles.set(rel, { db, mtimeMs: stat.mtimeMs, size: stat.size, usedAt: Date.now() });
  pruneSqliteHandles();
  return { db, rel, abs, stat };
}

function sqliteColumns(db, objectName) {
  const quoted = quoteIdent(objectName);
  let info;
  try {
    info = db.prepare(`pragma table_info(${quoted})`).all();
  } catch {
    return [];
  }
  return info.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    pk: Number(row.pk ?? 0) > 0,
    notNull: Number(row.notnull ?? 0) > 0,
  }));
}

/** The client always gets strings or null (null is SQL NULL; an empty string is a real empty string). */
function formatCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > SQLITE_MAX_CELL ? `${value.slice(0, SQLITE_MAX_CELL)}…` : value;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `[blob ${value.length} B]`;
  return String(value);
}

/** Use iterate to fetch only the needed rows: the synchronous API has no interrupt, so the only option is to cap the row count. */
function takeRows(statement, limit) {
  const rows = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push(row.map(formatCell));
  }
  return { rows, truncated };
}

function statementColumns(statement) {
  try {
    const info = statement.columns() ?? [];
    return info.map((column) => ({
      name: String(column.name ?? ""),
      type: String(column.type ?? ""),
      pk: false,
      notNull: false,
    }));
  } catch {
    return [];
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

async function handleSqliteOpen(payload) {
  const { db, rel, abs, stat } = await sqliteHandle(payload?.path ?? "");

  const rows = db
    .prepare("select type, name, tbl_name, sql from sqlite_master order by type, name")
    .all();

  const objects = rows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    tableName: String(row.tbl_name ?? ""),
    sql: typeof row.sql === "string" ? row.sql : null,
  }));

  return {
    ok: true,
    path: rel,
    info: sqliteInfo(
      await readHead(abs, 100),
      stat.size,
      await exists(`${abs}-wal`),
      await exists(`${abs}-journal`),
    ),
    objects,
  };
}

async function handleSqliteRows(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const requested = typeof payload?.object === "string" ? payload.object : "";
  const objects = db
    .prepare("select type, name from sqlite_master where type in ('table','view')")
    .all();
  // Object names never go into SQL directly: check them against the schema list first, then quote
  const target = objects.find((row) => String(row.name) === requested);
  if (!target) throw fail("SQLITE_NO_SUCH_OBJECT", `no such table or view: ${requested}`);

  const name = String(target.name);
  const columns = sqliteColumns(db, name);
  const known = new Set(columns.map((column) => column.name));

  let orderBy = typeof payload?.orderBy === "string" ? payload.orderBy : "";
  if (orderBy && orderBy !== ROWID && !known.has(orderBy)) orderBy = "";
  const direction = payload?.direction === "desc" ? "DESC" : "ASC";

  const pageSize = clampInt(payload?.pageSize, 1, SQLITE_MAX_ROWS, 1000);
  const page = clampInt(payload?.page, 1, 1e6, 1);
  const offset = (page - 1) * pageSize;
  if (offset > SQLITE_MAX_OFFSET) {
    throw fail("SQLITE_OFFSET_LIMIT", "this page is beyond the browsing limit");
  }

  const order = orderBy
    ? ` ORDER BY (${quoteIdent(orderBy)} IS NULL), ${quoteIdent(orderBy)} ${direction}`
    : "";
  const limit = pageSize + 1; // fetch one extra row to tell whether there is a next page

  let statement;
  let withRowid = true;
  try {
    statement = db.prepare(
      `SELECT ${ROWID}, * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`,
    );
  } catch {
    // Views and WITHOUT ROWID tables have no rowid; fall back to plain fetching
    withRowid = false;
    statement = db.prepare(`SELECT * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`);
  }
  statement.setReturnArrays(true);

  const { rows } = takeRows(statement, limit);
  const hasMore = rows.length > pageSize;

  let estimate = null;
  if (String(target.type) === "table") {
    try {
      const row = db.prepare(`SELECT max(rowid) AS m FROM ${quoteIdent(name)}`).get();
      estimate = typeof row?.m === "number" ? row.m : null;
    } catch {
      estimate = null;
    }
  }

  const resultColumns = withRowid
    ? [{ name: ROWID, type: "INTEGER", pk: true, notNull: true }, ...columns]
    : columns;

  return {
    ok: true,
    path: rel,
    object: name,
    kind: String(target.type),
    columns: resultColumns,
    rows: rows.slice(0, pageSize),
    page,
    pageSize,
    hasMore,
    estimate,
    hasRowid: withRowid,
  };
}

async function handleSqliteQuery(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const sql = typeof payload?.sql === "string" ? payload.sql.trim() : "";
  assertReadOnlySql(sql);

  const limit = clampInt(payload?.limit, 1, SQLITE_MAX_ROWS, 500);
  const started = Date.now();

  let statement;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  statement.setReturnArrays(true);
  const columns = statementColumns(statement);

  let rows = [];
  let truncated = false;
  try {
    ({ rows, truncated } = takeRows(statement, limit));
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  return {
    ok: true,
    path: rel,
    columns,
    rows,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

// ── Preferences ────────────────────────────────────────────────────────────

function sanitizePrefs(partial) {
  const next = { ...prefs };
  if (partial && typeof partial === "object") {
    if (typeof partial.splitRatio === "number" && Number.isFinite(partial.splitRatio)) {
      next.splitRatio = Math.min(Math.max(partial.splitRatio, 0.15), 0.7);
    }
    if (typeof partial.treeCollapsed === "boolean") next.treeCollapsed = partial.treeCollapsed;
    if (typeof partial.showIgnored === "boolean") next.showIgnored = partial.showIgnored;
    if (typeof partial.watchFiles === "boolean") next.watchFiles = partial.watchFiles;
    if (typeof partial.mdPreview === "boolean") next.mdPreview = partial.mdPreview;
    if (typeof partial.csvTable === "boolean") next.csvTable = partial.csvTable;
    if (typeof partial.jsonTree === "boolean") next.jsonTree = partial.jsonTree;
    // Table rows per page: clamped to 100–5000 and aligned to 100. The view's dropdown only offers a few fixed values;
    // this does not follow that enumeration (main.js should not know the view's option table), clamping is enough.
    if (typeof partial.tablePageSize === "number" && Number.isFinite(partial.tablePageSize)) {
      const rounded = Math.round(partial.tablePageSize / 100) * 100;
      next.tablePageSize = Math.min(Math.max(rounded, 100), 5000);
    }
    // Memory of "which folder root is shown" in a project group: projectKey → absolute path.
    // Only string values (no truthiness coercion), only absolute paths, kept bounded (LRU, see above).
    // Whether a value is "a root the host currently gives" is not decided here; that happens when deriving the base
    // (selectedRootOf); here only the shape is guaranteed.
    if (
      partial.projectRoots &&
      typeof partial.projectRoots === "object" &&
      !Array.isArray(partial.projectRoots)
    ) {
      for (const [key, value] of Object.entries(partial.projectRoots)) {
        if (!key || typeof value !== "string" || !isAbsolutePath(value)) continue;
        next.projectRoots = rememberProjectRoot(next.projectRoots, key, path.resolve(value));
      }
    }
  }
  return next;
}

async function handlePrefsSet(payload) {
  const partial = payload?.partial;
  // Only touching the root memory requires knowing the current project (and dropping the search sessions and
  // SQLite handles cached by relative path along the way: the same relative path under two roots is not the same file).
  const touchesRoots = Boolean(partial && typeof partial === "object" && "projectRoots" in partial);
  let key = null;
  let previous;
  if (touchesRoots) {
    const workspace = await pi.workspace.get().catch(() => null);
    key = workspace?.path ? projectKeyOf(workspace) : null;
    if (key) previous = (prefs.projectRoots ?? {})[key];
  }

  prefs = sanitizePrefs(partial);

  if (key && (prefs.projectRoots ?? {})[key] !== previous) dropRootScopedCaches();

  await pi.plugin.setSettings({ fmPrefs: prefs });
  return { ok: true, prefs };
}

async function handleHello() {
  // Group shape (primary root) + preferences. This is **not** the current base: the view reads this field in the same shape
  // as workspace.get, and the base is derived from prefs.projectRoots (both delivery paths have the same shape,
  // which keeps the "r:<primary root path>" memory key stable).
  const root = await projectGroup();
  return {
    ok: true,
    root,
    limits: {
      maxReadBytes: MAX_READ_BYTES,
      maxWriteBytes: MAX_WRITE_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
    },
    ignoreFiles: IGNORE_FILE_NAMES,
    // Whether this runtime can watch: if not, the view shows the "Auto-refresh" switch as unavailable
    // instead of letting the user turn it on with nothing ever happening.
    watch: { available: !isRemoteWorkspace(root) && watchSupported && fsWatchFn() !== null },
    // Older hosts may load this plugin before the built-in Browser action API exists.
    capabilities: { openHtmlInBrowser: !isRemoteWorkspace(root) && typeof pi.fs.openInBrowser === "function" },
    prefs,
  };
}

// ── Channel routing ────────────────────────────────────────────────────────

const CHANNELS = {
  "fm.hello": handleHello,
  "fm.prefs.get": handleHello,
  "fm.prefs.set": handlePrefsSet,
  "fm.list": handleList,
  "fm.read": handleRead,
  "fm.write": handleWrite,
  "fm.create": handleCreate,
  "fm.rename": handleRename,
  "fm.move": handleMove,
  "fm.delete": handleDelete,
  "fm.search": handleSearch,
  "fm.sqlite.open": handleSqliteOpen,
  "fm.sqlite.rows": handleSqliteRows,
  "fm.sqlite.query": handleSqliteQuery,
  "fm.git.diff": handleGitDiff,
  "fm.watch": handleWatch,
  // Editor detection and "Open with…" (0.9.0). The former really probes once a day (on-disk cache shared across instances),
  // the latter only accepts ids from the detection results; the view cannot choose an executable.
  "fm.editors": handleEditors,
  "fm.openWith": handleOpenWith,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    const workspace = await pi.workspace.get();
    if (payload?.workspacePath !== undefined && payload.workspacePath !== workspace?.path) {
      throw fail("WORKSPACE_CHANGED", "The workspace changed while the file was loading");
    }
    if (isRemoteWorkspace(workspace) && !["fm.hello", "fm.prefs.get", "fm.prefs.set"].includes(channel)) {
      return await invokeRemote(pi, workspace, channel, payload ?? {}, { isDenied, maxListEntries: MAX_LIST_ENTRIES });
    }
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
  try {
    const settings = await pi.plugin.getSettings();
    prefs = sanitizePrefs(settings?.fmPrefs ?? {});
  } catch {
    /* Keep the defaults */
  }
}

async function onUnload() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
  invalidateGitSnapshots();
  // The watcher must go with the plugin: leaking it leaves an eye on someone else's project (and a persistent one at that).
  stopWatching();
  // The in-memory editor detection cache goes with the plugin; the on-disk editors.json stays (other instances can use it today).
  editorCache = null;
  editorProbe = null;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // Pure parsing functions: verify-git.mjs unit-tests them directly (the porcelain / numstat / unified
  // diff forms can quietly change with a git upgrade, so parsing must be assertable).
  internals: {
    parsePorcelainV1,
    classifyRecord,
    parseNumstat,
    parseUnifiedDiff,
    untrackedDiff,
    rollupByChildDirectory,
    GIT_STATUS_RANK,
    GIT_TIMEOUT_MS,
    GIT_SNAPSHOT_TTL_MS,
    MAX_DIFF_LINES,
    MAX_UNTRACKED_DIFF_BYTES,
    // Pure watch decisions (0.8.0): noise filtering and own-write suppression, asserted directly by verify-watch.mjs.
    isWatchIgnored,
    isSelfWrite,
    noteSelfWrite,
    WATCH_DEBOUNCE_MS,
    SELF_WRITE_SUPPRESS_MS,
    WATCH_HISTORY_LIMIT,
    // Editor detection (0.9.0): output shapes and cache decisions are pure functions, asserted directly by verify-editors.mjs
    // (if parsing of the registry / shell command line / PATH candidate names went wrong, the menu would gain an
    // editor that does nothing when clicked, or miss one that really exists on the machine).
    parseAppPathsRegistry,
    parseStartMenuRegistry,
    executableFromCommand,
    pathLookupOrder,
    todayStamp,
    lookupRegistryKey,
    editorCandidates,
    detectEditors,
    EDITOR_CACHE_FILE,
  },
};
