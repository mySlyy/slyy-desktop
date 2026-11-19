// Slyy installation identity is frozen from the first release: updates
// (Squirrel.Mac designated requirement, NSIS GUID/exe), the userData folder,
// the safeStorage keychain entry and the data directory all key off these
// values. Changing one silently breaks updates or strands user data, so any
// change must be deliberate and fail here first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [pkgText, protocol, dataPaths, updateYml, updater, feedback, releases, tokens] = await Promise.all([
  read("../package.json"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron/main/data-paths.ts"),
  read("../resources/app-update.yml"),
  read("../electron/main/updater.ts"),
  read("../../../packages/shared/src/github-feedback.ts"),
  read("../../../packages/shared/src/github-releases.ts"),
  read("../src/styles/tokens.css"),
]);
const pkg = JSON.parse(pkgText);
const build = pkg.build;

test("installation identity stays frozen", () => {
  assert.equal(build.appId, "ai.slyy.desktop.gen2");
  assert.equal(build.productName, "Slyy Gen2");
  assert.equal(build.extraMetadata.name, "slyy-gen2");
  assert.equal(build.win.executableName, "Slyy Gen2");
  assert.equal(build.nsis.guid, "72db17f1-8935-5bae-870f-999d4b7621a6");
  assert.equal(build.linux.executableName, "slyy-gen2");
  assert.equal(pkg.desktopName, "slyy-gen2.desktop");
  assert.match(protocol, /APP_ID = "ai\.slyy\.desktop\.gen2"/);
  assert.match(protocol, /APP_INSTALLATION_NAME = "Slyy Gen2"/);
  assert.match(protocol, /APP_NAME = "Slyy"/);
  assert.match(dataPaths, /INSTALLATION_DATA_DIR_NAME = "\.slyy-gen2"/);
  assert.match(dataPaths, /DEVELOPMENT_DATA_DIR_NAME = "\.slyy-gen2-dev"/);
});

// The source repository is private; releases, the update feed and the remote
// pi-host bundles live in the public mySlyy/releases repository.
test("every update channel points at the public Slyy releases repository", () => {
  assert.deepEqual(build.publish, [{ provider: "github", owner: "mySlyy", repo: "releases" }]);
  assert.match(updateYml, /^owner: mySlyy$/m);
  assert.match(updateYml, /^repo: releases$/m);
  assert.match(updateYml, /^updaterCacheDirName: 'slyy-gen2-updater'$/m);
  assert.match(releases, /GITHUB_RELEASES_REPO = "mySlyy\/releases"/);
  assert.match(
    releases,
    /GITHUB_RELEASES_URL = `https:\/\/github\.com\/\$\{GITHUB_RELEASES_REPO\}\/releases\/latest`/,
  );
  assert.match(updater, /RELEASES_URL = GITHUB_RELEASES_URL;/);
});

test("feedback goes to the public releases repository; source metadata stays", () => {
  assert.match(feedback, /GITHUB_REPO = GITHUB_RELEASES_REPO;/);
  assert.equal(pkg.bugs.url, "https://github.com/mySlyy/releases/issues");
  assert.equal(pkg.repository.url, "git+https://github.com/mySlyy/slyy-desktop.git");
});

test("the shipped app carries the Slyy visual identity", () => {
  assert.match(tokens, /--ds-accent: #2b3bff;/);
  assert.match(tokens, /--radius-md: 0px;/);
  assert.match(tokens, /--font-sans: "Hanken Grotesk Variable"/);
  assert.match(tokens, /--font-mono: "Martian Mono Variable"/);
  assert.deepEqual(build.electronLanguages, ["en-US", "de"]);
  assert.doesNotMatch(pkgText, /PI-Desktop|vastsa|net\.aiuo/);
});
