/*
 * updater.cjs - in-app updates, the same way the real Slyy app does them:
 * electron-updater reads a feed, downloads the signed ZIP, and Squirrel.Mac
 * swaps the bundle on restart.
 *
 * Feed: the `publish` entry in package.json (generic provider). It points at
 * the rolling `desktop-wireframes-channel` release in mySlyy/releases, whose
 * only asset is latest-mac.yml; the file's URLs point at the versioned
 * release (desktop-wireframes-vX.Y.Z). Kept apart from the real app's feed
 * so neither ever offers the other's builds.
 *
 * Integrity: the ZIP's sha512 comes from latest-mac.yml over HTTPS, and
 * Squirrel.Mac refuses a bundle whose code signature does not satisfy the
 * running app's designated requirement (same Developer ID team).
 *
 * Packaged builds only. Checks once shortly after launch and every 6 hours;
 * nothing downloads without a click.
 */
"use strict";
const { app, dialog } = require("electron");
const { isQuitting } = require("./quit_guard.cjs");

const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{ getWindow: () => Electron.BrowserWindow|null, onChange: () => void }} deps
 */
function createUpdater({ getWindow, onChange }) {
	// "idle" | "checking" | "downloading" | "ready"
	let phase = "idle";
	let readyVersion = null;
	let autoUpdater = null;

	const setPhase = (p) => {
		phase = p;
		onChange();
	};
	const win = () => getWindow() || undefined;

	if (app.isPackaged) {
		({ autoUpdater } = require("electron-updater"));
		autoUpdater.autoDownload = false;
		autoUpdater.autoInstallOnAppQuit = true;
		autoUpdater.allowDowngrade = false;
		autoUpdater.logger = {
			info: (m) => console.log("[updater]", m),
			warn: (m) => console.warn("[updater]", m),
			error: (m) => console.error("[updater]", m),
			debug: () => {},
		};
		autoUpdater.on("download-progress", (p) => {
			const w = getWindow();
			if (w && !w.isDestroyed()) w.setProgressBar(Math.max(0, Math.min(1, (p.percent || 0) / 100)));
		});
	}

	function clearProgress() {
		const w = getWindow();
		if (w && !w.isDestroyed()) w.setProgressBar(-1);
	}

	async function promptRestart() {
		const { response } = await dialog.showMessageBox(win(), {
			type: "info",
			message: `Slyy Desktop ${readyVersion} is ready to install`,
			detail: "Restart now to finish the update, or it installs the next time you quit.",
			buttons: ["Restart Now", "Later"],
			defaultId: 0,
			cancelId: 1,
		});
		// Quitting closes the box as "Restart Now"; autoInstallOnAppQuit covers it.
		if (response === 0 && !isQuitting()) setImmediate(() => autoUpdater.quitAndInstall(false, true));
	}

	/** Check the feed. `manual` shows "up to date" and errors; background checks stay quiet. */
	async function check(manual) {
		if (!autoUpdater) {
			if (manual) {
				await dialog.showMessageBox(win(), {
					type: "info",
					message: "Updates work in the installed app only",
					detail: "This copy runs from source. Build and install the DMG to test updates.",
				});
			}
			return;
		}
		if (phase === "ready") return promptRestart();
		if (phase !== "idle") return;
		setPhase("checking");
		let result;
		try {
			result = await autoUpdater.checkForUpdates();
		} catch (err) {
			setPhase("idle");
			if (manual) {
				await dialog.showMessageBox(win(), {
					type: "warning",
					message: "Could not check for updates",
					detail: String(err?.message || err).split("\n")[0],
				});
			} else {
				console.warn("[updater] background check failed:", err?.message || err);
			}
			return;
		}
		const info = result?.updateInfo;
		if (!result?.isUpdateAvailable || !info) {
			setPhase("idle");
			if (manual) {
				await dialog.showMessageBox(win(), {
					type: "info",
					message: "You're up to date",
					detail: `Slyy Desktop ${app.getVersion()} is the newest version.`,
				});
			}
			return;
		}
		const { response } = await dialog.showMessageBox(win(), {
			type: "info",
			message: `Slyy Desktop ${info.version} is available`,
			detail: `You have ${app.getVersion()}. Download the update now?`,
			buttons: ["Download and Install", "Later"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response !== 0 || isQuitting()) {
			setPhase("idle");
			return;
		}
		setPhase("downloading");
		try {
			await autoUpdater.downloadUpdate();
		} catch (err) {
			clearProgress();
			setPhase("idle");
			await dialog.showMessageBox(win(), {
				type: "warning",
				message: "The update could not be downloaded",
				detail: String(err?.message || err).split("\n")[0],
			});
			return;
		}
		clearProgress();
		readyVersion = info.version;
		setPhase("ready");
		await promptRestart();
	}

	/** Start background checks (packaged only). */
	function start() {
		if (!autoUpdater) return;
		setTimeout(() => check(false), FIRST_CHECK_MS).unref?.();
		setInterval(() => check(false), CHECK_EVERY_MS).unref?.();
	}

	/** App-menu entry that mirrors the current phase. */
	function menuItem() {
		const label = {
			idle: "Check for Updates…",
			checking: "Checking for Updates…",
			downloading: "Downloading Update…",
			ready: "Restart to Update…",
		}[phase];
		return { id: "check-for-updates", label, enabled: phase === "idle" || phase === "ready", click: () => check(true) };
	}

	/** True while a downloaded update waits for a restart (keep its cache). */
	const hasPendingUpdate = () => phase === "downloading" || phase === "ready";

	return { start, check, menuItem, hasPendingUpdate };
}

module.exports = { createUpdater };
