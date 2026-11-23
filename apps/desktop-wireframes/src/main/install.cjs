/*
 * install.cjs - first-launch install step: when the app is opened straight
 * from the DMG, offer to move it to /Applications (Electron relaunches it
 * from there). Updates need the app in a writable place, so this matters
 * for the update flow too.
 */
"use strict";
const { app, dialog } = require("electron");
const core = require("./lifecycle_core.cjs");
const { isQuitting } = require("./quit_guard.cjs");

/**
 * Returns true when the app is being moved (and will relaunch), so the
 * caller skips the rest of its startup.
 */
async function offerMoveToApplications() {
	if (!app.isPackaged || process.platform !== "darwin") return false;
	if (app.isInApplicationsFolder() || !core.runsFromInstaller(process.execPath)) return false;
	const { response } = await dialog.showMessageBox({
		type: "question",
		message: "Move Slyy Desktop to the Applications folder?",
		detail: "It is running from the installer disk image. Updates and clean-up work once it is in Applications.",
		buttons: ["Move to Applications", "Not Now"],
		defaultId: 0,
		cancelId: 1,
	});
	if (response !== 0 || isQuitting()) return false;
	try {
		return app.moveToApplicationsFolder({
			conflictHandler: (type) => {
				if (type !== "exists") return true;
				// An older copy is in the way: replace it only on consent.
				const choice = dialog.showMessageBoxSync({
					type: "question",
					message: "Replace the Slyy Desktop already in Applications?",
					buttons: ["Replace", "Cancel"],
					defaultId: 0,
					cancelId: 1,
				});
				return choice === 0;
			},
		});
	} catch (err) {
		await dialog.showMessageBox({ type: "warning", message: "Could not move Slyy Desktop", detail: String(err?.message || err) });
		return false;
	}
}

module.exports = { offerMoveToApplications };
