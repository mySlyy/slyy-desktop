/*
 * preload.cjs - the only bridge between main and the wireframes renderer.
 * Exposes one subscription for menu commands; nothing else (no Node, no fs).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("slyyShell", {
	/** Subscribe to menu commands: { type: "navigate" | "back" | "forward", target? } */
	onCommand(callback) {
		if (typeof callback !== "function") return;
		ipcRenderer.on("shell:command", (_event, cmd) => callback(cmd));
	},
});
