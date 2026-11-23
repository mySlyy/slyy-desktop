/*
 * cleanup.cjs - remove installer leftovers after install and update.
 *
 * What it may remove (and nothing else):
 *   - mounted installer DMGs holding "Slyy Desktop.app": eject the volume,
 *     then move the .dmg file to the Trash (recoverable)
 *   - with `scanDownloads`: older installer DMGs in ~/Downloads, matched by
 *     exact artifact name (lifecycle_core.isInstallerName), to the Trash
 *   - the electron-updater download cache (~/Library/Caches/<name>-updater),
 *     deleted, once the update in it is installed
 *
 * Every run shows the plan first and does nothing without a click.
 */
"use strict";
const { app, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./lifecycle_core.cjs");
const { isQuitting } = require("./quit_guard.cjs");

/** Run a command without a shell; resolve stdout, never reject. */
function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
	});
}

function sizeOf(p) {
	try {
		const st = fs.statSync(p);
		if (!st.isDirectory()) return st.size;
		let total = 0;
		for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
		return total;
	} catch {
		return 0;
	}
}

/** ~/Library/Caches/<updaterCacheDirName> of the packaged app, or null. */
function updateCacheDir() {
	if (!app.isPackaged) return null;
	try {
		const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
		const name = core.parseUpdaterCacheDirName(yml);
		return name ? path.join(os.homedir(), "Library", "Caches", name) : null;
	} catch {
		return null;
	}
}

/**
 * Build the clean-up plan.
 * @param {{ scanDownloads?: boolean, includeUpdateCache?: boolean }} opts
 */
async function collectPlan({ scanDownloads = false, includeUpdateCache = true } = {}) {
	const appBundle = `${core.PRODUCT_NAME}.app`;
	const images = core
		.installerImages(core.parseHdiutilInfo(await run("/usr/bin/hdiutil", ["info"])), (mp) =>
			fs.existsSync(path.join(mp, appBundle)),
		)
		// Never eject the volume this process runs from.
		.filter((img) => !img.mountPoints.some((mp) => process.execPath.startsWith(`${mp}/`)))
		.map((img) => ({ ...img, size: sizeOf(img.imagePath) }));

	const files = [];
	if (scanDownloads) {
		const dir = app.getPath("downloads");
		const mounted = new Set(images.map((img) => img.imagePath));
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			names = [];
		}
		for (const name of names.filter(core.isInstallerName)) {
			const p = path.join(dir, name);
			if (!mounted.has(p)) files.push({ path: p, size: sizeOf(p) });
		}
	}

	let updateCache = null;
	const cacheDir = includeUpdateCache ? updateCacheDir() : null;
	if (cacheDir && fs.existsSync(cacheDir)) updateCache = { path: cacheDir, size: sizeOf(cacheDir) };

	return { images, files, updateCache };
}

/** Carry out a plan; returns the lines that failed (empty on success). */
async function executePlan(plan) {
	const failed = [];
	for (const img of plan.images) {
		for (const mp of img.mountPoints) {
			const ok = await new Promise((resolve) =>
				execFile("/usr/bin/hdiutil", ["detach", mp], { timeout: 30000 }, (err) => resolve(!err)),
			);
			if (!ok) failed.push(`Eject "${core.basename(mp)}"`);
		}
		try {
			await shell.trashItem(img.imagePath);
		} catch {
			failed.push(`Move ${core.basename(img.imagePath)} to the Trash`);
		}
	}
	for (const f of plan.files) {
		try {
			await shell.trashItem(f.path);
		} catch {
			failed.push(`Move ${core.basename(f.path)} to the Trash`);
		}
	}
	if (plan.updateCache) {
		try {
			fs.rmSync(plan.updateCache.path, { recursive: true, force: true });
		} catch {
			failed.push("Remove downloaded update files");
		}
	}
	return failed;
}

/**
 * Show the plan and run it on confirmation.
 * @param {Electron.BrowserWindow|null} win
 * @param {{ reason: "install"|"upgrade"|"manual", scanDownloads?: boolean,
 *   includeUpdateCache?: boolean, onDontAskAgain?: () => void }} opts
 */
async function offerCleanup(win, opts) {
	const plan = await collectPlan(opts);
	const lines = core.describePlan(plan);
	if (lines.length === 0) {
		if (opts.reason === "manual") {
			await dialog.showMessageBox(win, { type: "info", message: "Nothing to clean up", detail: "No installer files or downloaded updates were found." });
		}
		return;
	}
	const heading = {
		install: `${core.PRODUCT_NAME} is installed. Clean up the installer?`,
		upgrade: `${core.PRODUCT_NAME} is updated to ${app.getVersion()}. Clean up?`,
		manual: "Clean up installer files?",
	}[opts.reason];
	const res = await dialog.showMessageBox(win, {
		type: "question",
		message: heading,
		detail: lines.map((l) => `• ${l}`).join("\n"),
		buttons: ["Clean Up", "Not Now"],
		defaultId: 0,
		cancelId: 1,
		checkboxLabel: opts.onDontAskAgain ? "Don't ask after install and update" : undefined,
		checkboxChecked: false,
	});
	// A dialog closed by quitting resolves as "Clean Up": never act on it.
	if (isQuitting()) return;
	if (res.checkboxChecked && opts.onDontAskAgain) opts.onDontAskAgain();
	if (res.response !== 0) return;
	const failed = await executePlan(plan);
	if (failed.length) {
		await dialog.showMessageBox(win, {
			type: "warning",
			message: "Some items could not be cleaned up",
			detail: failed.map((l) => `• ${l}`).join("\n"),
		});
	}
}

module.exports = { offerCleanup, collectPlan, updateCacheDir };
