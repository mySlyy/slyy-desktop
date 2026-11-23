/*
 * app.js - click-dummy shell: navigation, history, overview and badge.
 *
 * Screens come from the generated screens.js (DCRuntime registry, canvas
 * order). Commands from the macOS menu arrive through the preload bridge
 * `window.slyyDummy` (see src/main/preload.cjs).
 */
(function app(root) {
	"use strict";
	const { DCRuntime, DCCore } = root;

	const OVERVIEW = "overview";
	const screenEl = document.getElementById("dummy-screen");
	const overviewEl = document.getElementById("dummy-overview");
	const styleEl = document.getElementById("dc-screen-style");
	const badgeLabel = document.getElementById("dummy-badge-label");
	const backBtn = document.getElementById("dummy-badge-back");
	const fwdBtn = document.getElementById("dummy-badge-forward");

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
			document.title = "Slyy Click-Dummy · Overview";
			badgeLabel.textContent = "Overview";
		} else {
			const host = hostFor(target);
			overviewEl.hidden = true;
			screenEl.hidden = false;
			styleEl.textContent = host.meta.style;
			host.activate();
			document.title = `Slyy Click-Dummy · ${host.meta.title}`;
			badgeLabel.textContent = host.meta.title.split(" · ")[0] || host.meta.id;
		}
		root.scrollTo(0, 0);
		backBtn.disabled = cursor <= 0;
		fwdBtn.disabled = cursor >= history.length - 1;
	}

	/** Navigate to a screen file or the overview, recording history. */
	function navigate(target) {
		if (target !== OVERVIEW && !DCRuntime.has(target)) {
			console.warn(`[click-dummy] no wireframe for ${target}`);
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
		// "noop" (#) and "blocked" links do nothing in a click-dummy.
	});

	// Overview list, built once in canvas order.
	const list = document.getElementById("dummy-overview-list");
	screens.forEach((s, i) => {
		const li = document.createElement("li");
		li.id = `dummy-overview-item-${i + 1}`;
		const a = document.createElement("a");
		a.id = `dummy-overview-link-${i + 1}`;
		a.href = s.file;
		const t = document.createElement("strong");
		t.id = `dummy-overview-name-${i + 1}`;
		t.textContent = s.title;
		const f = document.createElement("span");
		f.id = `dummy-overview-file-${i + 1}`;
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

	document.getElementById("dummy-badge-overview").addEventListener("click", () => navigate(OVERVIEW));
	backBtn.addEventListener("click", back);
	fwdBtn.addEventListener("click", forward);

	// macOS menu commands (Screens / Go menus).
	if (root.slyyDummy && typeof root.slyyDummy.onCommand === "function") {
		root.slyyDummy.onCommand((cmd) => {
			if (!cmd || typeof cmd !== "object") return;
			if (cmd.type === "navigate" && typeof cmd.target === "string") navigate(cmd.target);
			else if (cmd.type === "back") back();
			else if (cmd.type === "forward") forward();
		});
	}

	// Start on the canvas entry artboard (first in order), else the overview.
	navigate(screens.length ? screens[0].file : OVERVIEW);
})(globalThis);
