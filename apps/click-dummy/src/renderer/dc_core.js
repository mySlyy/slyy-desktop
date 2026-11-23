/*
 * dc_core.js - pure, DOM-free helpers of the click-dummy template runtime.
 *
 * The wireframes are Design Component files (`*.dc.html`) exported from the
 * "Slyy Desktop Wireframes" canvas. Their markup uses `{{ path }}` holes that
 * are resolved against the values a screen's `renderVals()` returns, plus the
 * loop variables of `<sc-for>`.
 *
 * This file is loaded twice:
 *   - in the renderer as a classic script (attaches `globalThis.DCCore`)
 *   - in Node by the build script and the unit tests (`module.exports`)
 * so it must not touch `document` or any Electron API.
 */
(function factory(root) {
	"use strict";

	// A hole is `{{ path }}`; the path is a dotted lookup, never an expression.
	const HOLE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
	// An attribute whose whole value is one hole receives the raw value
	// (function, boolean, number, object) instead of a string.
	const WHOLE_HOLE_RE = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/;

	/**
	 * Resolve one hole expression against a scope object.
	 * Supports literals (true, false, null, undefined, numbers, quoted
	 * strings) and dotted paths such as `it.cardStyle` or `$index`.
	 * Unknown paths resolve to `undefined`, as in the design runtime.
	 */
	function evalHole(expr, scope) {
		const src = String(expr).trim();
		if (src === "true") return true;
		if (src === "false") return false;
		if (src === "null") return null;
		if (src === "undefined" || src === "") return undefined;
		if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
		const quoted = /^(['"])(.*)\1$/.exec(src);
		if (quoted) return quoted[2];
		let cur = scope;
		for (const key of src.split(".")) {
			if (cur === null || cur === undefined) return undefined;
			// Own properties only: a template must not reach the prototype chain.
			if (typeof cur === "object" || typeof cur === "function") {
				cur = Object.hasOwn(cur, key) ? cur[key] : undefined;
			} else {
				return undefined;
			}
		}
		return cur;
	}

	/** Replace every hole in a text with its string value (null -> ""). */
	function interpolate(text, scope) {
		return String(text).replace(HOLE_RE, (_m, expr) => {
			const v = evalHole(expr, scope);
			return v === null || v === undefined ? "" : String(v);
		});
	}

	/** Return the inner expression if the value is exactly one hole. */
	function wholeHole(value) {
		const m = WHOLE_HOLE_RE.exec(String(value));
		return m ? m[1] : null;
	}

	/**
	 * Decide how a raw (whole-hole) attribute value is written to the DOM.
	 * Returns `{ kind: "event" | "skip" | "set", value }`.
	 *   - `on*` attributes bind a function as an event listener; any other
	 *     value on an `on*` attribute is dropped (no inline handlers).
	 *   - aria-* and data-* keep booleans as "true"/"false" (like React).
	 *   - other attributes are omitted for false/null/undefined.
	 */
	function attrPlan(name, raw) {
		const lower = name.toLowerCase();
		if (lower.startsWith("on")) {
			return typeof raw === "function" ? { kind: "event", value: raw, event: lower.slice(2) } : { kind: "skip" };
		}
		if (lower.startsWith("aria-") || lower.startsWith("data-")) {
			return raw === null || raw === undefined ? { kind: "skip" } : { kind: "set", value: String(raw) };
		}
		if (raw === false || raw === null || raw === undefined) return { kind: "skip" };
		if (raw === true) return { kind: "set", value: "" };
		return { kind: "set", value: String(raw) };
	}

	/**
	 * Classify a link target inside a wireframe.
	 *   "noop"     - `#` placeholder links of the wireframe
	 *   "anchor"   - `#id` scroll target inside the screen
	 *   "screen"   - another artboard, e.g. `Spaces.dc.html`
	 *   "external" - https URL, opened in the system browser
	 *   "blocked"  - anything else (file:, javascript:, http: ...)
	 */
	function classifyHref(href) {
		const h = String(href || "").trim();
		if (h === "" || h === "#") return { kind: "noop" };
		if (h.startsWith("#")) return { kind: "anchor", target: h.slice(1) };
		const screen = /^\/?([A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html)$/.exec(h);
		if (screen) return { kind: "screen", target: screen[1] };
		if (/^https:\/\//i.test(h)) return { kind: "external", target: h };
		return { kind: "blocked" };
	}

	const api = { evalHole, interpolate, wholeHole, attrPlan, classifyHref };
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.DCCore = api;
})(typeof globalThis === "undefined" ? this : globalThis);
