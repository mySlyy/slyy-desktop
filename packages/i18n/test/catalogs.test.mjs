import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catalogs,
  en,
  flattenCatalog,
  listedLocales,
  resolveLocale,
  supportedLocales,
} from "../src/index.ts";

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

const english = flattenCatalog(en);

test("offline storage maintenance has localized progress and recovery copy before renderer startup", () => {
  const fields = ["progressTitle", "progressHint", "failedTitle", "failedHint", "continueOriginal", "unavailableHint"];
  const stages = ["scanning", "copying", "verifying", "relocating", "cleaning", "complete", "failed"];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const copy = catalog.settings.storage;
    for (const field of fields) {
      assert.equal(typeof copy[field], "string", `${locale}: ${field}`);
      assert.ok(copy[field].trim(), `${locale}: ${field} must not be blank`);
    }
    assert.deepEqual(Object.keys(copy.stages).sort(), [...stages].sort(), locale);
    for (const stage of stages) assert.ok(copy.stages[stage].trim(), `${locale}: ${stage}`);
    if (locale !== "en") {
      assert.notEqual(copy.progressTitle, en.settings.storage.progressTitle, locale);
      assert.notEqual(copy.failedHint, en.settings.storage.failedHint, locale);
      assert.notEqual(copy.unavailableHint, en.settings.storage.unavailableHint, locale);
    }
  }
});

test("every shipped catalog matches English keys and interpolation variables", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.deepEqual(Object.keys(flat).sort(), Object.keys(english).sort(), id);
    for (const key of Object.keys(english)) {
      assert.deepEqual(placeholders(flat[key]), placeholders(english[key]), `${id} ${key}`);
    }
  }
});

test("Live Voice preparation and call recovery copy is localized in every shipped catalog", () => {
  const keys = [
    "prepareCall", "details", "workOptions", "allowWork", "noWorkSession",
    "playbackBlocked", "playbackFailed", "mediaReleaseUnconfirmed",
    "callActionFailed", "workNotConnected", "transcript", "transcriptEmpty",
    "userSpeaking", "assistantSpeaking", "muted", "resumePlayback",
    "selectWorkSession", "shareContext", "contextShared",
    "contextNotShared", "createWorkSession", "viewWorkSession", "enableDetail",
    "microphoneDenied", "microphoneUnavailable", "microphoneBusy",
    "phase.connecting", "phase.closing",
  ].map((key) => `liveVoice.${key}`);

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.equal(typeof flat[key], "string", `${id} ${key}`);
      assert.notEqual(flat[key].trim(), "", `${id} ${key}`);
      if (id !== "en") assert.notEqual(flat[key], english[key], `${id} ${key} must not fall back to English`);
    }
  }

  assert.match(english["liveVoice.enableDetail"], /current Composer session as the default work target/);
  assert.match(english["liveVoice.enableDetail"], /switch sessions by voice/);
});

test("MCP OAuth no-DCR recovery guidance is localized in every shipped catalog", () => {
  const key = "extensions.mcp.authDcrUnavailable";
  for (const [id, catalog] of Object.entries(catalogs)) {
    const value = flattenCatalog(catalog)[key];
    assert.equal(typeof value, "string", `${id} ${key}`);
    assert.notEqual(value.trim(), "", `${id} ${key}`);
    if (id !== "en") assert.notEqual(value, english[key], `${id} ${key} must not fall back to English`);
  }
});

test("canonical thinking levels are not translated catalog entries", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effortKeys = [
    "chat.effortOff",
    "chat.effortMinimal",
    "chat.effortLow",
    "chat.effortMid",
    "chat.effortHigh",
    "chat.effortXhigh",
    "chat.effortMax",
  ];

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const level of levels) {
      assert.equal(flat[`thinkingLevel.${level}`], undefined, `${id} ${level}`);
    }
    for (const key of effortKeys) {
      assert.equal(flat[key], undefined, `${id} ${key}`);
    }
  }
});

test("settings subagent empty-state copy uses a non-conflicting key", () => {
  assert.equal(english["settings.subagentsEmpty"], "No subagents of your own yet");
  assert.equal(typeof english["settings.subagents"], "string");
  assert.equal(typeof english["extensions.subagents.empty"], "string");
});

test("creation-phase delegation copy is catalog-backed", () => {
  assert.equal(english["chat.subagentCreating"], "Starting subagent…");
  for (const [id, catalog] of Object.entries(catalogs)) {
    assert.equal(
      typeof flattenCatalog(catalog)["chat.subagentCreating"],
      "string",
      id,
    );
  }
});

test("settings rail labels stay concise and parallel across locales", () => {
  const keys = [
    "appearance",
    "chat",
    "shortcuts",
    "voice",
    "behavior",
    "models",
    "instructions",
    "skills",
    "mcp",
    "subagents",
    "projects",
    "system",
    "sync",
    "remoteHosts",
    "info",
  ].map((key) => `settings.nav.${key}`);

  assert.deepEqual(
    keys.map((key) => english[key]),
    [
      "Appearance",
      "Conversation",
      "Shortcuts",
      "Voice",
      "Behavior",
      "Models",
      "Instructions",
      "Skills",
      "MCP",
      "Subagents",
      "Projects",
      "System",
      "Cloud sync",
      "Remote hosts",
      "Info",
    ],
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.equal(typeof flat[key], "string", `${id} ${key}`);
      assert.ok(flat[key].trim(), `${id} ${key} must not be blank`);
    }
    for (const retired of ["general", "ai", "import"]) {
      assert.equal(flat[`settings.nav.${retired}`], undefined, `${id} ${retired}`);
    }
  }
  assert.equal(english["settings.import"], undefined);
  assert.equal(english["settings.groupPreferences"], "Preferences");
  assert.equal(english["settings.groupSystem"], "System");
});

test("import, project, and temporary-session copy is catalog-backed", () => {
  for (const key of [
    "nav.temporarySessions",
    "nav.newTemporarySession",
    "settings.importGroupByPath",
    "settings.importNoProject",
    "settings.importSourceClaudeCode",
    "project.selectProject",
    "project.openActions",
    "project.sessions",
  ]) {
    assert.equal(typeof english[key], "string", key);
    assert.notEqual(english[key], "");
  }
});

test("locale resolution maps variants onto shipped catalogs and falls back to English", () => {
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("de"), "de");
  assert.equal(resolveLocale("de-DE"), "de");
  assert.equal(resolveLocale("de_AT"), "de");
  assert.equal(resolveLocale("zh-CN"), "en");
  assert.equal(resolveLocale("fr-CA"), "en");
  assert.equal(resolveLocale("pt-BR"), "en");
  assert.equal(resolveLocale(), "en");
});

test("the locale registry lists English first, then other locales by English name", () => {
  assert.deepEqual(
    supportedLocales.map((locale) => locale.id),
    ["en", "de"],
  );
  assert.deepEqual(
    listedLocales().map((locale) => locale.id),
    ["en", "de"],
  );
  assert.equal(localeInfoNative("de"), "Deutsch");
  assert.equal(english["settings.languageSearchPlaceholder"], "Search languages…");
  assert.equal(english["settings.themeSearchPlaceholder"], "Search themes…");
  assert.equal(english["settings.languageAutoDesc"], "Currently {{state}}");
  const german = flattenCatalog(catalogs.de);
  assert.equal(german["settings.language"], "Sprache");
  assert.equal(german["settings.languageAuto"], "Systemsprache verwenden");
  assert.equal(german["nav.projects"], "Projekte");
  assert.notEqual(german["app.tagline"], english["app.tagline"]);
});

function localeInfoNative(id) {
  return supportedLocales.find((locale) => locale.id === id)?.nativeName;
}

test("inline review cards expose localized accessible labels", () => {
  assert.equal(
    english["chat.reviewChangeShow"],
    "Show {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    english["chat.reviewChangeHide"],
    "Hide {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    english["chat.reviewChangeCounts"],
    "{{additions}} additions, {{deletions}} deletions",
  );
  assert.equal(english["panel.review.filesChanged_one"], "1 file changed");
  assert.equal(
    english["panel.review.filesChanged_other"],
    "{{count}} files changed",
  );
  assert.equal(english["panel.review.changes_one"], "1 recorded change");
});
