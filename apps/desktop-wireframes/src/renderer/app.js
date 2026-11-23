/*
 * app.js - wireframes shell: navigation, history and the screen overview.
 *
 * Screens come from the generated screens.js (DCRuntime registry, canvas
 * order). Commands from the macOS menu arrive through the preload bridge
 * `window.slyyShell` (see src/main/preload.cjs).
 */
(function app(root) {
	"use strict";
	const { DCRuntime, DCCore } = root;

	const OVERVIEW = "overview";
	const screenEl = document.getElementById("shell-screen");
	const overviewEl = document.getElementById("shell-overview");
	const styleEl = document.getElementById("dc-screen-style");

	const screens = DCRuntime.list();
	const hosts = new Map(); // file -> ScreenHost, kept so clicks survive navigation
	const history = [];
	let cursor = -1;
	let current = null;

	/** Lazily create the host of a screen (state lives as long as the window). */
	function hostFor(file) {
		let host = hosts.get(file);
		if (!host) {
			host = new DCRuntime.ScreenHost(file, screenEl);
			hosts.set(file, host);
		}
		return host;
	}

	/** Show a screen (or the overview) without touching history. */
	function show(target) {
		if (current && current !== OVERVIEW) hostFor(current).deactivate();
		current = target;
		if (target === OVERVIEW) {
			screenEl.hidden = true;
			overviewEl.hidden = false;
			styleEl.textContent = "";
			screenEl.replaceChildren();
		} else {
			const host = hostFor(target);
			overviewEl.hidden = true;
			screenEl.hidden = false;
			styleEl.textContent = host.meta.style;
			host.activate();
		}
		root.scrollTo(0, 0);
	}

	/** Navigate to a screen file or the overview, recording history. */
	function navigate(target) {
		if (target !== OVERVIEW && !DCRuntime.has(target)) {
			console.warn(`[desktop-wireframes] no wireframe for ${target}`);
			return;
		}
		if (target === current) return;
		history.splice(cursor + 1);
		history.push(target);
		cursor = history.length - 1;
		show(target);
	}

	function back() {
		if (cursor > 0) {
			cursor -= 1;
			show(history[cursor]);
		}
	}

	function forward() {
		if (cursor < history.length - 1) {
			cursor += 1;
			show(history[cursor]);
		}
	}

	/** Links inside a wireframe: other screens, anchors, external https. */
	screenEl.addEventListener("click", (ev) => {
		const a = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
		if (!a) return;
		ev.preventDefault();
		const link = DCCore.classifyHref(a.getAttribute("href"));
		if (link.kind === "screen") navigate(link.target);
		else if (link.kind === "anchor") document.getElementById(link.target)?.scrollIntoView({ behavior: "smooth" });
		else if (link.kind === "external") root.open(link.target, "_blank", "noopener");
		// "noop" (#) and "blocked" links do nothing in the wireframes.
	});

	// Overview list, built once in canvas order.
	const list = document.getElementById("shell-overview-list");
	screens.forEach((s, i) => {
		const li = document.createElement("li");
		li.id = `shell-overview-item-${i + 1}`;
		const a = document.createElement("a");
		a.id = `shell-overview-link-${i + 1}`;
		a.href = s.file;
		const t = document.createElement("strong");
		t.id = `shell-overview-name-${i + 1}`;
		t.textContent = s.title;
		const f = document.createElement("span");
		f.id = `shell-overview-file-${i + 1}`;
		f.className = "file";
		f.textContent = s.file;
		a.append(t, f);
		a.addEventListener("click", (ev) => {
			ev.preventDefault();
			navigate(s.file);
		});
		li.append(a);
		list.append(li);
	});

	// macOS menu commands (Screens / Go menus).
	if (root.slyyShell && typeof root.slyyShell.onCommand === "function") {
		root.slyyShell.onCommand((cmd) => {
			if (!cmd || typeof cmd !== "object") return;
			if (cmd.type === "navigate" && typeof cmd.target === "string") navigate(cmd.target);
			else if (cmd.type === "back") back();
			else if (cmd.type === "forward") forward();
		});
	}

	// Start on the canvas entry artboard (first in order), else the overview.
	navigate(screens.length ? screens[0].file : OVERVIEW);
})(globalThis);
