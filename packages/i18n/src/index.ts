export { en, type EnglishCatalog } from "./locales/en/index.js";
export { default as enDefault } from "./locales/en/index.js";
export { de } from "./locales/de/index.js";
export { default as deDefault } from "./locales/de/index.js";

export * from "./locale-info.js";

import { en, type EnglishCatalog } from "./locales/en/index.js";
import { de } from "./locales/de/index.js";

import type { AppLocale } from "./locale-info.js";

export const catalogs: Record<AppLocale, EnglishCatalog> = {
  en,
  de,
};
