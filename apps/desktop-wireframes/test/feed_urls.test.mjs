/*
 * Tests of scripts/feed_urls.mjs (update feed rewrite). IDs: T-DW-3xx.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { absolutizeFeed, releaseBase } from "../scripts/feed_urls.mjs";

const FEED = `version: 0.2.0
files:
  - url: slyy-desktop-0.2.0-mac-arm64.zip
    sha512: abc==
    size: 111
  - url: slyy-desktop-0.2.0-mac-arm64.dmg
    sha512: def==
    size: 222
path: slyy-desktop-0.2.0-mac-arm64.zip
sha512: abc==
releaseDate: '2026-11-23T12:00:00.000Z'
`;
const TAG = "desktop-wireframes-v0.2.0";
const BASE = "https://github.com/mySlyy/releases/releases/download/desktop-wireframes-v0.2.0/";

test("T-DW-301 relative url/path entries become absolute release URLs", () => {
	const out = absolutizeFeed(FEED, "mySlyy/releases", TAG);
	assert.match(out, new RegExp(`^  - url: ${BASE}slyy-desktop-0\\.2\\.0-mac-arm64\\.zip$`, "m"));
	assert.match(out, new RegExp(`^  - url: ${BASE}slyy-desktop-0\\.2\\.0-mac-arm64\\.dmg$`, "m"));
	assert.match(out, new RegExp(`^path: ${BASE}slyy-desktop-0\\.2\\.0-mac-arm64\\.zip$`, "m"));
	assert.match(out, /^sha512: abc==$/m, "hashes untouched");
	assert.match(out, /^releaseDate: '2026-11-23T12:00:00.000Z'$/m);
});

test("T-DW-302 an already rewritten feed is refused, not rewritten again", () => {
	const once = absolutizeFeed(FEED, "mySlyy/releases", TAG);
	assert.throws(() => absolutizeFeed(once, "mySlyy/releases", TAG), /no files/);
});

test("T-DW-303 version/tag mismatch and bad input are refused", () => {
	assert.throws(() => absolutizeFeed(FEED, "mySlyy/releases", "desktop-wireframes-v0.3.0"), /does not match/);
	assert.throws(() => absolutizeFeed(FEED, "mySlyy/releases", "v0.2.0"), /bad tag/);
	assert.throws(() => absolutizeFeed(FEED, "evil/repo/x", TAG), /bad repo/);
	assert.throws(() => absolutizeFeed("files: []\n", "mySlyy/releases", TAG), /no version/);
	assert.throws(() => absolutizeFeed(FEED.replace("path: slyy", "path: ../slyy"), "mySlyy/releases", TAG), /unexpected path/);
});

test("T-DW-304 release base URL", () => {
	assert.equal(releaseBase("mySlyy/releases", TAG), BASE);
});
