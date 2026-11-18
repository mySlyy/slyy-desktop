import assert from "node:assert/strict";
import test from "node:test";
import { pluginProviderCatalogEntries } from "../electron/main/plugin-provider-catalog.ts";

function plugin(id, name, permissions, providers) {
  return {
    permissions: new Set(permissions),
    manifest: { id, name, contributes: { providers } },
  };
}

test("the provider catalog is permission-filtered, API-key-only, localized and stable", () => {
  const entries = pluginProviderCatalogEntries([
    plugin("community.sites", "Community Sites", ["provider.register"], [
      {
        id: "second",
        name: "Second",
        baseUrl: "https://second.example/v1",
        category: { en: "Community", "zh-CN": "Community (zh-CN)" },
        description: { en: "A community API with check-in credits.", "zh-CN": "A community API with check-in credits. (zh-CN)" },
        models: [{ id: "second-model" }],
      },
      {
        id: "oauth",
        name: "Subscription",
        baseUrl: "https://oauth.example/v1",
        authKind: "oauth",
        models: [{ id: "oauth-model" }],
      },
      {
        id: "no-auth",
        name: "No authentication",
        baseUrl: "https://local.example/v1",
        authKind: "none",
        models: [{ id: "local-model" }],
      },
      {
        id: "missing-endpoint",
        name: "No endpoint",
        models: [{ id: "local-model" }],
      },
    ]),
    plugin("community.first", "First Plugin", ["provider.register"], [
      {
        id: "first",
        name: "First",
        baseUrl: "https://first.example/v1",
        category: "Community (zh-CN)",
        models: [{ id: "first-model" }],
      },
    ]),
    plugin("unapproved.plugin", "Unapproved", [], [
      {
        id: "hidden",
        name: "Hidden",
        baseUrl: "https://hidden.example/v1",
        models: [{ id: "hidden-model" }],
      },
    ]),
  ], "zh-CN");

  assert.deepEqual(entries, [
    {
      pluginId: "community.sites",
      providerId: "plugin:community.sites:second",
      pluginName: "Community Sites",
      category: "Community (zh-CN)",
      description: "A community API with check-in credits. (zh-CN)",
    },
    {
      pluginId: "community.first",
      providerId: "plugin:community.first:first",
      pluginName: "First Plugin",
      category: "Community (zh-CN)",
    },
  ]);
});

test("a missing category falls back to the plugin name", () => {
  const entries = pluginProviderCatalogEntries([
    plugin("demo.providers", "Demo Providers", ["provider.register"], [{
      id: "demo",
      name: "Demo",
      baseUrl: "https://demo.example/v1",
      models: [{ id: "demo-model" }],
    }]),
  ], "en");

  assert.equal(entries[0]?.category, "Demo Providers");
});

test("a localized provider category follows the active app locale", () => {
  const sources = [plugin("demo.providers", "Demo Providers", ["provider.register"], [{
    id: "demo",
    name: "Demo",
    baseUrl: "https://demo.example/v1",
    category: { en: "Community", "zh-CN": "Community (zh-CN)" },
    models: [{ id: "demo-model" }],
  }])];

  assert.equal(pluginProviderCatalogEntries(sources, "en")[0]?.category, "Community");
  assert.equal(pluginProviderCatalogEntries(sources, "zh-CN")[0]?.category, "Community (zh-CN)");
});

test("the provider catalog resolves a localized one-sentence introduction", () => {
  const sources = [plugin("demo.providers", "Demo Providers", ["provider.register"], [{
    id: "demo",
    name: "Demo",
    baseUrl: "https://demo.example/v1",
    description: { en: "A short introduction.", "zh-CN": "A short introduction. (zh-CN)" },
    models: [{ id: "demo-model" }],
  }])];

  assert.equal(pluginProviderCatalogEntries(sources, "en")[0]?.description, "A short introduction.");
  assert.equal(pluginProviderCatalogEntries(sources, "zh-CN")[0]?.description, "A short introduction. (zh-CN)");
});
