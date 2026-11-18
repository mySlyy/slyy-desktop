import type { HostedSearchContent } from "@earendil-works/pi-ai";
import { normalizeHostedSearchContent } from "@earendil-works/pi-ai/utils/hosted-search";
import { LocalRequestError } from "@earendil-works/pi-ai/utils/local-request-error";
import type { HostedSearch } from "@pi-desktop/shared";

/**
 * The persisted type stays backward compatible; it narrows to the formal
 * search type only at the boundary where it enters the model context.
 *
 * Old records without a replay still display. A record with a replay has two
 * cases: a container that is not an array is a corrupt record and still fails
 * as a local error; a single block that cannot be replayed degrades the whole
 * replay to empty, matching an old record that has "no replay" for the message.
 *
 * The persistence layer explicitly allows blocks without a blockId: when the
 * gateway drops the id, the display path falls back to an anonymous round
 * (`native-web-search.ts`). Such records were readable before an upgrade and
 * must not make every request of the session fail after it: a request-level
 * failure cannot be recovered by restarting or reopening the session, while
 * the search replay is only part of that message's context. The degradation
 * stays observable and copies neither search content nor credentials.
 */
export function restoreHostedSearchReplay(
  search: HostedSearch | undefined,
): HostedSearchContent[] {
  if (search?.replay === undefined) return [];
  if (!Array.isArray(search.replay)) throw new LocalRequestError("context-validation");
  try {
    return search.replay.map((block) => normalizeHostedSearchContent(block));
  } catch (error) {
    reportUnreplayableSearchReplay(search.replay, error);
    return [];
  }
}

/**
 * Logs only the block count and the stage: enough to locate the data shape
 * without writing search results or credentials to the log.
 */
function reportUnreplayableSearchReplay(
  replay: readonly unknown[],
  error: unknown,
): void {
  const phases = [
    ...new Set(
      replay
        .map((block) => (block as { phase?: unknown } | null)?.phase)
        .filter((phase): phase is string => typeof phase === "string"),
    ),
  ];
  console.warn(
    `[hosted-search] dropping an unreplayable stored search record ` +
      `(${replay.length} block(s), phases: ${phases.join(", ") || "none"})`,
    error,
  );
}
