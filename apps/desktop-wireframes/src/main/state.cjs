/*
 * state.cjs - tiny persisted app state in <userData>/state.json.
 *
 *   lastVersion   version of the previous launch (install/upgrade detection)
 *   offerCleanup  ask to clean up installer files after install and update
 *
 * Written atomically (tmp + rename) with mode 0600. A missing or broken file
 * falls back to defaults, which only means one extra clean-up offer.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({ lastVersion: null, offerCleanup: true });

function createState(userDataDir) {
	const file = path.join(userDataDir, "state.json");
	let data = { ...DEFAULTS };
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw && typeof raw === "object") {
			if (typeof raw.lastVersion === "string") data.lastVersion = raw.lastVersion;
			if (typeof raw.offerCleanup === "boolean") data.offerCleanup = raw.offerCleanup;
		}
	} catch (err) {
		if (err.code !== "ENOENT") console.warn("[desktop-wireframes] state.json unreadable, using defaults:", err.message);
	}

	function save() {
		fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	return {
		get: (key) => data[key],
		set(key, value) {
			data = { ...data, [key]: value };
			try {
				save();
			} catch (err) {
				console.error("[desktop-wireframes] cannot write state.json:", err.message);
			}
		},
	};
}

module.exports = { createState };
