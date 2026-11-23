/*
 * Tests of src/main/lifecycle_core.cjs (install, update, clean-up helpers).
 * IDs: T-DW-2xx.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require("../src/main/lifecycle_core.cjs");

// Shape of `hdiutil info` on macOS 15/26 (abridged).
const HDIUTIL = `framework       : 742.40.1
driver          : 742.40.1
================================================
image-path      : /Users/a/Downloads/slyy-desktop-0.1.0-mac-arm64.dmg
image-alias     : /Users/a/Downloads/slyy-desktop-0.1.0-mac-arm64.dmg
shadow-path     : <none>
icon-path       : /System/Library/PrivateFrameworks/DiskImages.framework/Resources/CDiskImage.icns
image-type      : read-only disk image
/dev/disk4\tGUID_partition_scheme\t
/dev/disk4s1\tApple_HFS\t/Volumes/Slyy Desktop 0.1.0-arm64
================================================
image-path      : /Users/a/Downloads/Other App.dmg
/dev/disk5\tGUID_partition_scheme\t
/dev/disk5s1\tApple_APFS\t/Volumes/Other App
================================================
image-path      : /Users/a/Downloads/slyy-desktop-0.0.9-mac-arm64.dmg
/dev/disk6\tGUID_partition_scheme\t
`;

test("T-DW-201 installer names: only our DMG pattern matches", () => {
	assert.ok(core.isInstallerName("slyy-desktop-0.1.0-mac-arm64.dmg"));
	assert.ok(core.isInstallerName("slyy-desktop-1.2.3-beta.1-mac-arm64.dmg"));
	for (const bad of [
		"Slyy-0.23.0-arm64.dmg", // the real app's installer is not ours to delete
		"slyy-desktop-0.1.0-mac-arm64.dmg.part",
		"slyy-desktop-0.1.0-mac-arm64.zip",
		"slyy-desktop-latest-mac-arm64.dmg",
		"../slyy-desktop-0.1.0-mac-arm64.dmg",
		"",
		null,
	]) {
		assert.equal(core.isInstallerName(bad), false, String(bad));
	}
});

test("T-DW-202 hdiutil info parses images and mount points", () => {
	const images = core.parseHdiutilInfo(HDIUTIL);
	assert.deepEqual(images, [
		{ imagePath: "/Users/a/Downloads/slyy-desktop-0.1.0-mac-arm64.dmg", mountPoints: ["/Volumes/Slyy Desktop 0.1.0-arm64"] },
		{ imagePath: "/Users/a/Downloads/Other App.dmg", mountPoints: ["/Volumes/Other App"] },
		{ imagePath: "/Users/a/Downloads/slyy-desktop-0.0.9-mac-arm64.dmg", mountPoints: [] },
	]);
	assert.deepEqual(core.parseHdiutilInfo(""), []);
});

test("T-DW-203 installer images: our name, mounted, holding the app", () => {
	const images = core.parseHdiutilInfo(HDIUTIL);
	const withApp = core.installerImages(images, () => true);
	assert.deepEqual(withApp.map((i) => i.imagePath), ["/Users/a/Downloads/slyy-desktop-0.1.0-mac-arm64.dmg"]);
	assert.deepEqual(core.installerImages(images, () => false), [], "volume without Slyy Desktop.app is left alone");
});

test("T-DW-204 launch kind: install, upgrade, same version", () => {
	assert.equal(core.launchKind(null, "0.1.0"), "install");
	assert.equal(core.launchKind("0.1.0", "0.1.1"), "upgrade");
	assert.equal(core.launchKind("0.1.1", "0.1.1"), null);
});

test("T-DW-205 updater cache dir name is a single safe segment", () => {
	assert.equal(core.parseUpdaterCacheDirName("provider: generic\nupdaterCacheDirName: pi-desktop-desktop-wireframes-updater\n"), "pi-desktop-desktop-wireframes-updater");
	assert.equal(core.parseUpdaterCacheDirName("updaterCacheDirName: '@x-updater'\n"), "@x-updater");
	for (const bad of ["updaterCacheDirName: ../../Documents-updater", "updaterCacheDirName: Documents", "updaterCacheDirName: .x-updater", "updaterCacheDirName: a/b-updater", "provider: generic"]) {
		assert.equal(core.parseUpdaterCacheDirName(bad), null, bad);
	}
});

test("T-DW-206 runs from installer: DMG volume or App Translocation", () => {
	assert.ok(core.runsFromInstaller("/Volumes/Slyy Desktop 0.1.0-arm64/Slyy Desktop.app/Contents/MacOS/Slyy Desktop"));
	assert.ok(core.runsFromInstaller("/private/var/folders/x/AppTranslocation/ABC/d/Slyy Desktop.app/Contents/MacOS/Slyy Desktop"));
	assert.equal(core.runsFromInstaller("/Applications/Slyy Desktop.app/Contents/MacOS/Slyy Desktop"), false);
});

test("T-DW-207 sizes and plan lines for the clean-up dialog", () => {
	assert.equal(core.formatBytes(512), "512 B");
	assert.equal(core.formatBytes(108302062), "108 MB");
	assert.equal(core.formatBytes(1500000), "1.5 MB");
	const lines = core.describePlan({
		images: [{ imagePath: "/Users/a/Downloads/slyy-desktop-0.1.0-mac-arm64.dmg", mountPoints: ["/Volumes/Slyy Desktop 0.1.0-arm64"], size: 108302062 }],
		files: [{ path: "/Users/a/Downloads/slyy-desktop-0.0.9-mac-arm64.dmg", size: 0 }],
		updateCache: { path: "/x", size: 2500000 },
	});
	assert.deepEqual(lines, [
		'Eject "Slyy Desktop 0.1.0-arm64"',
		"Move slyy-desktop-0.1.0-mac-arm64.dmg to the Trash (108 MB)",
		"Move slyy-desktop-0.0.9-mac-arm64.dmg to the Trash",
		"Remove downloaded update files (2.5 MB)",
	]);
	assert.deepEqual(core.describePlan({ images: [], files: [], updateCache: null }), []);
});
