/**
 * Session links (`slyy://session/<id>`): the one way a conversation is
 * referenced from another one. Links copied before the Slyy rebrand use the
 * `pi-desktop://` scheme; they are still recognized everywhere, but only the
 * `slyy://` form is ever produced. Neither scheme is registered with the OS:
 * links are plain text resolved inside the app.
 *
 * The link is plain text the user pastes into a Composer draft (or copies from
 * the session row), so referencing a conversation adds no new Composer trigger
 * symbol: `@` stays files and `/` stays commands (see `composer-trigger.ts`).
 * Electron main turns the tokens it finds in a prompt into bounded session
 * references before the turn is dispatched; the renderer only formats and
 * recognizes them.
 */

/** Scheme of every session link Slyy produces. */
export const SESSION_LINK_SCHEME = "slyy";
/** Pre-rebrand scheme, parsed for compatibility and never produced. */
export const LEGACY_SESSION_LINK_SCHEME = "pi-desktop";
/** Every accepted `<scheme>://session/` prefix, current scheme first. */
export const SESSION_LINK_PREFIXES: readonly string[] = [
  SESSION_LINK_SCHEME,
  LEGACY_SESSION_LINK_SCHEME,
].map((scheme) => `${scheme}://session/`);
/** Path segment that marks a session link. */
export const SESSION_LINK_HOST = "session";
/** References one message may carry; the rest stay plain text in the draft. */
export const MAX_SESSION_LINKS_PER_MESSAGE = 4;
/** Session ids are UUIDs; remote ids use `remote:` and never match. */
const SESSION_LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The id must end the token: a trailing `:` or `/` means this is a remote id
 * (`remote:…`) or a deeper path, so nothing is referenced at all.
 */
const SESSION_LINK_PATTERN =
  /(?:slyy|pi-desktop):\/\/session\/([A-Za-z0-9_-]{1,64})(?![A-Za-z0-9_:/-])/g;

/** Cheap pre-check before running the pattern. */
function mayContainSessionLink(text: string): boolean {
  return SESSION_LINK_PREFIXES.some((prefix) => text.includes(prefix));
}

/** The link a session row copies and a Composer draft accepts. */
export function formatSessionLink(sessionId: string): string {
  return `${SESSION_LINK_SCHEME}://${SESSION_LINK_HOST}/${sessionId}`;
}

/**
 * Every distinct session a draft references, in first-mention order. A trailing
 * `)` or `.` a sentence added is not part of the id: the id character class
 * already stops at those.
 */
export function parseSessionLinks(text: string): string[] {
  if (!text || !mayContainSessionLink(text)) return [];
  const found: string[] = [];
  for (const match of text.matchAll(SESSION_LINK_PATTERN)) {
    const id = match[1];
    if (!SESSION_LINK_ID.test(id)) continue;
    if (found.includes(id)) continue;
    found.push(id);
    if (found.length >= MAX_SESSION_LINKS_PER_MESSAGE) break;
  }
  return found;
}

/** Whether one token is a session link, used by renderer mention parsing. */
export function isSessionLinkToken(token: string): boolean {
  return parseSessionLinks(token).length > 0;
}

/** The session id when the whole token is one session link, otherwise null. */
export function parseSessionLinkToken(text: string): string | null {
  const trimmed = text.trim();
  if (!SESSION_LINK_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  const ids = parseSessionLinks(trimmed);
  return ids.length === 1 && trimmed.endsWith(ids[0]) ? ids[0] : null;
}

/** Every session link in `text` with the span it occupies, in text order. */
export function sessionLinkSpans(
  text: string,
): Array<{ id: string; start: number; end: number }> {
  if (!text || !mayContainSessionLink(text)) return [];
  const spans: Array<{ id: string; start: number; end: number }> = [];
  for (const match of text.matchAll(SESSION_LINK_PATTERN)) {
    const id = match[1];
    if (!SESSION_LINK_ID.test(id) || match.index === undefined) continue;
    spans.push({ id, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}
