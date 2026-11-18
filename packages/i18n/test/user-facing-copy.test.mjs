import assert from "node:assert/strict";
import { test } from "vitest";
import { de, en, flattenCatalog } from "../src/index.ts";

const english = flattenCatalog(en);
const german = flattenCatalog(de);

test("shell status and crash copy stay user-facing", () => {
  assert.equal(english["app.tagline"], "Local AI coding partner");
  assert.equal(
    english["app.uiCrashed"],
    "Something went wrong with the interface",
  );
  assert.equal(english["status.hostOk"], "Connected");
  assert.equal(english["status.degraded"], "Limited");
  assert.equal(english["status.fatal"], "Can't reach the local service");
  assert.equal(
    english["status.unsupportedGlibc"],
    "This Linux build needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36+).",
  );
  assert.equal(english["errors.TURN_ABORTED"], "Stopped.");
});

test("failed turns expose a localized continuation prompt", () => {
  assert.equal(
    english["chat.continueUnfinishedTaskPrompt"],
    "Continue the user's unfinished task.",
  );
  assert.equal(
    english["errors.MUTATION_RETRY_BUDGET_EXHAUSTED"],
    "The same edit failed three times, so this turn stopped instead of retrying blind. Ask again to continue.",
  );
});

test("common setup and marketplace copy avoid developer jargon", () => {
  assert.equal(english["nav.temporarySessions"], "Temporary chats");
  assert.equal(english["menu.refreshMarket"], "Refresh marketplace");
  assert.equal(english["settings.providers"], "AI providers");
  assert.doesNotMatch(english["menu.refreshMarket"], /from repo/i);
  assert.doesNotMatch(english["status.hostOk"], /Host/i);
  assert.doesNotMatch(english["status.fatal"], /backend/i);
});

test("Plan mode and Auto permission copy stay explicit in both locales", () => {
  assert.equal(english["settings.modePlan"], "Plan");
  assert.equal(english["plan.approvalRegion"], "Plan approval");
  assert.equal(
    english["plan.readyAnnouncement"],
    "Plan ready. The plan is open in the Work Panel.",
  );
  assert.equal(english["plan.approveAsk"], "Approve (Ask)");
  assert.equal(english["plan.approveAcceptEdits"], "Approve (Accept edits)");
  assert.equal(english["plan.approveAuto"], "Approve (Auto)");
  assert.equal(english["plan.chooseApprovalMode"], "Choose approval mode");
  assert.match(english["plan.autoWarning"], /may change files/);
  assert.equal(german["plan.approvalRegion"], "Plangenehmigung");
});

/**
 * E2E-024X: a page may not restate its own title as a subtitle, and a setting
 * may not explain an obvious control. These keys were rendered once and are
 * gone; keep them gone in every locale.
 */
const REMOVED_EXPLANATORY_KEYS = [
  "project.subtitle",
  "project.archiveSubtitle",
  "project.emptyIndexBody",
  "scheduled.emptyBody",
  "chat.emptyHint",
  "panel.empty.body",
  "panel.review.noChangesHint",
  "settings.languageDesc",
  "settings.devToolsDesc",
  "settings.themeLightDesc",
  "settings.themeDarkDesc",
  "settings.themeSystemDesc",
  "settings.applicationDesc",
  "settings.logsDesc",
  "settings.fontDesc",
  "settings.shortcutDescription",
  "settings.importScanDesc",
  "settings.linkOpenTargetDesc",
  "settings.commandShellDesc",
  "settings.contextUsageDisplayDesc",
  "settings.closeBehaviorTrayDesc",
  "settings.closeBehaviorQuitDesc",
  "settings.capabilityNoMatchesHint",
  "settings.fullAccessDesc",
  "settings.autoReviewDesc",
  "settings.defaultPermissionsDesc",
  "settings.apiKeyHint",
  "settings.baseUrlHint",
  "settings.apiStyleDesc",
  "plugins.newFromTemplateHint",
  "plugins.newFromTemplateBody",
  "plugins.selectVersion",
  "extensions.mcp.labelHint",
  "extensions.mcp.transportStdioHint",
  "extensions.mcp.transportHttpHint",
  "extensions.mcp.descriptionHint",
];

test("removed explanatory copy stays removed", () => {
  for (const key of REMOVED_EXPLANATORY_KEYS) {
    assert.equal(english[key], undefined, `en still defines ${key}`);
    assert.equal(german[key], undefined, `de still defines ${key}`);
  }
});

test("font size presets use Starbucks-style cup names", () => {
  assert.equal(english["settings.fontSizeSmall"], "Tall");
  assert.equal(english["settings.fontSizeDefault"], "Grande");
  assert.equal(english["settings.fontSizeLarge"], "Venti");
  assert.equal(english["settings.fontSizeXl"], "Trenta");
});

test("chat context-menu copy stays user-facing", () => {
  assert.equal(english["chat.copyFailed"], "Couldn't copy to the clipboard");
  assert.equal(english["chat.messageMenu"], "Message actions");
  assert.equal(english["chat.copyConversation"], "Copy conversation");
});
