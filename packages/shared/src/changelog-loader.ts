import { resolveChangelogLocale } from "./changelog-runtime.js";
import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

export { normalizeChangelogVersion, resolveChangelogLocale } from "./changelog-runtime.js";

type CatalogLoader = () => Promise<readonly ChangelogEntry[]>;

const catalogLoaders: Record<ChangelogLocale, CatalogLoader> = {
  en: () => import("./changelog-en.js").then((module) => module.enEntries),
  de: () => import("./changelog-de.js").then((module) => module.deEntries),
};

const catalogRequests = new Map<ChangelogLocale, Promise<readonly ChangelogEntry[]>>();

export function loadChangelogCatalog(
  localeInput?: string | null,
): Promise<readonly ChangelogEntry[]> {
  const locale = resolveChangelogLocale(localeInput);
  const existing = catalogRequests.get(locale);
  if (existing) return existing;

  const request = catalogLoaders[locale]();
  catalogRequests.set(locale, request);
  void request.catch(() => {
    if (catalogRequests.get(locale) === request) catalogRequests.delete(locale);
  });
  return request;
}
