/*
 * lifecycle_core.cjs - pure helpers for install, update and clean-up.
 *
 * No Electron, no filesystem: everything here takes plain values so the
 * unit tests (test/lifecycle_core.test.mjs, T-DW-2xx) cover it directly.
 * The Electron side lives in updater.cjs, cleanup.cjs and install.cjs.
 */
"use strict";

/** Product name; the .app bundle is "<PRODUCT_NAME>.app". */
const PRODUCT_NAME = "Slyy Desktop";

/**
 * Installer DMGs this app publishes, e.g. slyy-desktop-0.2.0-mac-arm64.dmg
 * (artifactName in package.json). Clean-up only ever touches files whose
 * basename matches, never anything else in Downloads or on a volume.
 */
const INSTALLER_RE = /^slyy-desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-mac-arm64\.dmg$/;

function isInstallerName(name) {
	return typeof name === "string" && INSTALLER_RE.test(name);
}

/**
 * Parse `hdiutil info` (text form) into disk images and their mount points.
 * Each image block starts with a "=====" separator line, carries an
 * `image-path : <path>` line, and lists its devices as tab-separated rows
 * whose last column is the mount point (if mounted).
 */
function parseHdiutilInfo(text) {
	const images = [];
	let cur = null;
	for (const raw of String(text || "").split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (/^=+$/.test(line.trim())) {
			cur = { imagePath: null, mountPoints: [] };
			images.push(cur);
			continue;
		}
		if (!cur) continue;
		const m = /^image-path\s*:\s*(.+)$/.exec(line);
		if (m) {
			cur.imagePath = m[1].trim();
			continue;
		}
		// Device rows: "/dev/disk4s1\t<content hint>\t/Volumes/Slyy Desktop 0.1.0-arm64"
		if (line.startsWith("/dev/")) {
			const cols = line.split("\t").map((c) => c.trim());
			const last = cols[cols.length - 1];
			if (cols.length > 1 && last.startsWith("/Volumes/")) cur.mountPoints.push(last);
		}
	}
	return images.filter((img) => img.imagePath);
}

/**
 * The mounted images that are our installer: the image file is named like
 * our DMG and one of its volumes holds "<PRODUCT_NAME>.app".
 * `hasApp(mountPoint)` is injected so this stays pure.
 */
function installerImages(images, hasApp) {
	return images
		.filter((img) => isInstallerName(basename(img.imagePath)))
		.map((img) => ({ ...img, mountPoints: img.mountPoints.filter((mp) => hasApp(mp)) }))
		.filter((img) => img.mountPoints.length > 0);
}

/** Last path segment, for POSIX paths. */
function basename(p) {
	const s = String(p || "").replace(/\/+$/, "");
	return s.slice(s.lastIndexOf("/") + 1);
}

/**
 * What changed since the previous launch: "install" (first launch ever),
 * "upgrade" (version differs), or null (same version).
 */
function launchKind(lastVersion, currentVersion) {
	if (!lastVersion) return "install";
	return lastVersion === currentVersion ? null : "upgrade";
}

/**
 * electron-updater keeps its downloads in ~/Library/Caches/<dir>; the name is
 * written by electron-builder into Resources/app-update.yml. Accept only a
 * single, plain path segment so a tampered file cannot point clean-up at
 * another directory.
 */
function parseUpdaterCacheDirName(yml) {
	const m = /^updaterCacheDirName:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(String(yml || ""));
	if (!m) return null;
	const name = m[1];
	if (!/^[A-Za-z0-9._@-]+-updater$/.test(name) || name.startsWith(".")) return null;
	return name;
}

/**
 * True when the running bundle sits on a mounted DMG or in an App
 * Translocation folder, i.e. it was opened straight from the installer.
 */
function runsFromInstaller(exePath) {
	const p = String(exePath || "");
	return p.startsWith("/Volumes/") || p.includes("/AppTranslocation/");
}

/** "108 MB" style sizes for dialogs (decimal units, like Finder). */
function formatBytes(n) {
	if (!Number.isFinite(n) || n < 0) return "";
	if (n < 1000) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let v = n;
	let u = -1;
	do {
		v /= 1000;
		u += 1;
	} while (v >= 1000 && u < units.length - 1);
	return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Dialog lines for a clean-up plan; empty plan -> empty list. */
function describePlan(plan) {
	const lines = [];
	for (const img of plan.images || []) {
		for (const mp of img.mountPoints) lines.push(`Eject "${basename(mp)}"`);
		lines.push(`Move ${basename(img.imagePath)} to the Trash${img.size ? ` (${formatBytes(img.size)})` : ""}`);
	}
	for (const f of plan.files || []) {
		lines.push(`Move ${basename(f.path)} to the Trash${f.size ? ` (${formatBytes(f.size)})` : ""}`);
	}
	if (plan.updateCache) {
		const size = plan.updateCache.size ? ` (${formatBytes(plan.updateCache.size)})` : "";
		lines.push(`Remove downloaded update files${size}`);
	}
	return lines;
}

module.exports = {
	PRODUCT_NAME,
	isInstallerName,
	parseHdiutilInfo,
	installerImages,
	basename,
	launchKind,
	parseUpdaterCacheDirName,
	runsFromInstaller,
	formatBytes,
	describePlan,
};
