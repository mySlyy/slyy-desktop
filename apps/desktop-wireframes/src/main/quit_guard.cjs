/*
 * quit_guard.cjs - "is the app quitting?" for dialog callers.
 *
 * Quitting while a message box is open closes it, and Electron resolves the
 * promise with the default button (index 0). For clean-up that would mean
 * trashing files nobody confirmed, so callers check isQuitting() before
 * acting on a response.
 */
"use strict";
const { app } = require("electron");

let quitting = false;
app.on("before-quit", () => {
	quitting = true;
});

module.exports = { isQuitting: () => quitting };
