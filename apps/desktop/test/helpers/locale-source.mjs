import { readFile } from "node:fs/promises";

/**
 * The German catalog quotes its keys (`"key": "value"`) while English uses
 * bare identifiers. Source contracts match `key:`, so normalize quoted keys.
 */
export function unquoteCatalogKeys(source) {
  return source.replace(/"([A-Za-z_$][\w$]*)"(\s*):/g, "$1$2:");
}

export async function readLocaleSource(id) {
  const source = await readFile(
    new URL(`../../../../packages/i18n/src/locales/${id}/index.ts`, import.meta.url),
    "utf8",
  );
  return unquoteCatalogKeys(source);
}
