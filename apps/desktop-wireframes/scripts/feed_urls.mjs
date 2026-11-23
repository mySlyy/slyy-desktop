#!/usr/bin/env node
/*
 * feed_urls.mjs - make the macOS update feed point at the versioned release.
 *
 * electron-builder writes release/latest-mac.yml with file names relative to
 * the feed URL. The feed lives in the rolling `desktop-wireframes-channel`
 * release, but the ZIP/DMG live in `desktop-wireframes-v<version>`, so every
 * relative `url:` / `path:` entry is rewritten to an absolute https URL.
 *
 * Usage: node scripts/feed_urls.mjs <latest-mac.yml> <tag> [owner/repo]
 * Default repo: mySlyy/releases. Tested in test/feed_urls.test.mjs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /^desktop-wireframes-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Base URL of a release's downloadable assets. */
export function releaseBase(repo, tag) {
	if (!REPO_RE.test(repo)) throw new Error(`bad repo: ${repo}`);
	if (!TAG_RE.test(tag)) throw new Error(`bad tag: ${tag} (expected desktop-wireframes-vX.Y.Z)`);
	return `https://github.com/${repo}/releases/download/${tag}/`;
}

/**
 * Rewrite relative `url:` (inside `files:`) and top-level `path:` values.
 * Throws when the feed's version does not match the tag, or when it has no
 * file entry at all, so a wrong feed never reaches the channel.
 */
export function absolutizeFeed(yml, repo, tag) {
	const base = releaseBase(repo, tag);
	const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yml)?.[1];
	if (!version) throw new Error("feed has no version");
	if (`desktop-wireframes-v${version}` !== tag) throw new Error(`feed version ${version} does not match tag ${tag}`);
	let count = 0;
	const out = yml.replace(/^(\s*(?:-\s+)?(?:url|path):\s*)(['"]?)([^'"\n]+)\2\s*$/gm, (line, key, _q, value) => {
		if (/^https:\/\//.test(value)) return line;
		if (value.includes("/") || value.includes("..")) throw new Error(`unexpected path in feed: ${value}`);
		count += 1;
		return `${key}${base}${encodeURIComponent(value)}`;
	});
	if (count === 0) throw new Error("feed lists no files");
	return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [file, tag, repo = "mySlyy/releases"] = process.argv.slice(2);
	if (!file || !tag) {
		console.error("usage: feed_urls.mjs <latest-mac.yml> <tag> [owner/repo]");
		process.exit(2);
	}
	writeFileSync(file, absolutizeFeed(readFileSync(file, "utf8"), repo, tag));
	console.log(`feed_urls: ${file} -> ${releaseBase(repo, tag)}`);
}
