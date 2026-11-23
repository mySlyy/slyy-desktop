/*
 * dc_runtime.js - minimal renderer for the compiled wireframe screens.
 *
 * Implements the subset of the Design Component format the wireframes use:
 *   - `{{ path }}` holes in text and attributes
 *   - <sc-for list as> and <sc-if value> (compiled to <template data-sc>)
 *   - `onClick="{{ fn }}"` style event bindings
 *   - `class Component extends DCLogic` with state / setState / renderVals
 *
 * Every render rebuilds the screen's DOM from its template; the wireframes
 * are small, so this keeps the runtime trivial. Scroll positions and the
 * values of author-id'd inputs survive a re-render.
 *
 * Depends on: dc_core.js (globalThis.DCCore).
 */
(function runtime(root) {
	"use strict";
	const { evalHole, interpolate, wholeHole, attrPlan } = root.DCCore;

	/** Base class the wireframe logic extends (React-like surface). */
	class DCLogic {
		constructor(props) {
			this.props = props || {};
			this.state = {};
			this._host = null;
		}
		setState(patch) {
			const next = typeof patch === "function" ? patch(this.state, this.props) : patch;
			this.state = { ...this.state, ...(next || {}) };
			if (this._host) this._host.scheduleRender();
		}
		forceUpdate() {
			if (this._host) this._host.scheduleRender();
		}
		renderVals() {
			return {};
		}
	}

	// Elements a wireframe may not render (the design format forbids them too).
	const BLOCKED_TAGS = new Set(["script", "iframe", "object", "embed", "frame", "frameset", "base", "meta", "link"]);

	// file -> { meta, factory }
	const registry = new Map();

	/** Called by the generated screens.js once per wireframe. */
	function register(meta, factory) {
		registry.set(meta.file, { meta, factory });
	}

	/**
	 * Render template children into `out`.
	 * `ctx.autoId` hands out deterministic ids (`<screen>-<tag>-<n>`) so
	 * every rendered element carries an id, as the house rules require.
	 */
	function renderChildren(parent, scope, out, ctx) {
		for (const node of parent.childNodes) renderNode(node, scope, out, ctx);
	}

	function renderNode(node, scope, out, ctx) {
		if (node.nodeType === Node.TEXT_NODE) {
			out.appendChild(document.createTextNode(interpolate(node.nodeValue, scope)));
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;

		if (node.localName === "template" && node.dataset.sc === "for") {
			const list = evalHole(wholeHole(node.getAttribute("list")) ?? "", scope);
			const as = node.getAttribute("as") || "item";
			if (Array.isArray(list)) {
				list.forEach((item, i) => {
					renderChildren(node.content, { ...scope, [as]: item, $index: i }, out, ctx);
				});
			}
			return;
		}
		if (node.localName === "template" && node.dataset.sc === "if") {
			if (evalHole(wholeHole(node.getAttribute("value")) ?? "", scope)) renderChildren(node.content, scope, out, ctx);
			return;
		}

		// The template is parsed inert (<template>), and active elements are
		// never re-created, so markup cannot smuggle code into the renderer.
		if (BLOCKED_TAGS.has(node.localName)) return;

		// Keep the parsed namespace so inline <svg> children stay SVG.
		const el = document.createElementNS(node.namespaceURI, node.localName);
		for (const attr of node.attributes) {
			if (attr.name.startsWith("hint-")) continue; // editor-only placeholders
			const expr = wholeHole(attr.value);
			if (expr !== null) {
				const plan = attrPlan(attr.name, evalHole(expr, scope));
				if (plan.kind === "event") el.addEventListener(plan.event, plan.value);
				else if (plan.kind === "set") el.setAttribute(attr.name, plan.value);
			} else if (!attr.name.toLowerCase().startsWith("on")) {
				// Literal inline handlers are never copied (CSP forbids them anyway).
				el.setAttribute(attr.name, interpolate(attr.value, scope));
			}
		}
		if (!el.hasAttribute("id")) {
			ctx.n += 1;
			el.setAttribute("id", `${ctx.prefix}-${node.localName}-${ctx.n}`);
			el.setAttribute("data-dc-auto-id", "");
		}
		renderChildren(node, scope, el, ctx);
		out.appendChild(el);
	}

	/**
	 * A mounted screen: owns the logic instance and re-renders into `mount`.
	 * Instances are cached by the shell, so a screen keeps its state while
	 * the user navigates around the wireframes.
	 */
	class ScreenHost {
		constructor(file, mount) {
			const entry = registry.get(file);
			if (!entry) throw new Error(`Unknown screen: ${file}`);
			this.meta = entry.meta;
			this.mount = mount;
			const Component = entry.factory(DCLogic);
			this.logic = new Component({});
			this.logic._host = this;
			this.tpl = document.createElement("template");
			this.tpl.innerHTML = this.meta.template;
			this.pending = false;
			this.active = false;
		}

		scheduleRender() {
			if (this.pending || !this.active) return;
			this.pending = true;
			queueMicrotask(() => {
				this.pending = false;
				if (this.active) this.render();
			});
		}

		render() {
			// Remember what a full re-render would otherwise reset.
			const scroll = new Map();
			const values = new Map();
			for (const el of this.mount.querySelectorAll("[id]")) {
				if (el.scrollTop || el.scrollLeft) scroll.set(el.id, [el.scrollTop, el.scrollLeft]);
				if (!el.hasAttribute("data-dc-auto-id") && "value" in el) values.set(el.id, el.value);
			}
			const pageScroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
			const focusedId = document.activeElement && document.activeElement.id;

			const vals = this.logic.renderVals() || {};
			const frag = document.createDocumentFragment();
			renderChildren(this.tpl.content, { ...vals }, frag, { prefix: `dc-${this.meta.id}`, n: 0 });
			this.mount.replaceChildren(frag);

			for (const [id, v] of values) {
				const el = document.getElementById(id);
				if (el && "value" in el) el.value = v;
			}
			for (const [id, [top, left]] of scroll) {
				const el = document.getElementById(id);
				if (el) {
					el.scrollTop = top;
					el.scrollLeft = left;
				}
			}
			if (document.scrollingElement) document.scrollingElement.scrollTop = pageScroll;
			if (focusedId) {
				const el = document.getElementById(focusedId);
				if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
			}
		}

		activate() {
			this.active = true;
			this.render();
		}

		deactivate() {
			this.active = false;
		}
	}

	root.DCRuntime = {
		DCLogic,
		register,
		ScreenHost,
		has: (file) => registry.has(file),
		list: () => [...registry.values()].map((e) => e.meta),
	};
})(globalThis);
