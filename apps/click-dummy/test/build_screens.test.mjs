/*
 * Tests of the wireframe compiler (scripts/build_screens.mjs) against the
 * real canvas export in wireframes/. IDs: T-CD-1xx.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { compileScreen, emitScreensJs, sortByNumber } from "../scripts/build_screens.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_DIR = path.join(APP_DIR, "wireframes");
const canvas = JSON.parse(readFileSync(path.join(WIRE_DIR, "canvas.json"), "utf8"));
const files = readdirSync(WIRE_DIR).filter((f) => f.endsWith(".dc.html"));

/** Compile every wireframe on disk. */
function compileAll() {
	return files.map((f) => compileScreen(f, readFileSync(path.join(WIRE_DIR, f), "utf8"), canvas.boards?.[f]?.title));
}

/** Run the generated screens.js in a VM with a stub runtime; return instances. */
function loadScreens(screens) {
	class DCLogic {
		constructor(props) {
			this.props = props || {};
			this.state = {};
		}
		setState(patch) {
			this.state = { ...this.state, ...patch };
		}
	}
	const registered = [];
	const context = vm.createContext({
		DCRuntime: { register: (meta, factory) => registered.push({ meta, Component: factory(DCLogic) }) },
	});
	new vm.Script(emitScreensJs(screens), { filename: "screens.js" }).runInContext(context);
	return registered;
}

test("T-CD-101 every artboard in canvas.json exists on disk", () => {
	for (const f of canvas.order) assert.ok(files.includes(f), `${f} missing in wireframes/`);
	assert.equal(files.length, canvas.order.length);
});

test("T-CD-102 every wireframe compiles; loops/ifs become templates", () => {
	for (const s of compileAll()) {
		assert.ok(s.title.length > 0, `${s.file} title`);
		assert.ok(!/<sc-(for|if)\b/.test(s.template), `${s.file} still has sc-* tags`);
		assert.ok(!s.template.includes("<helmet>"), `${s.file} helmet not stripped`);
		assert.ok(!s.template.includes("fonts.googleapis.com"), `${s.file} still loads Google Fonts`);
	}
});

test("T-CD-103 unsupported design tags fail the build", () => {
	const src =
		'<title>x</title><x-dc><dc-import name="Card"></dc-import></x-dc><script type="text/x-dc">class Component extends DCLogic {}</script>';
	assert.throws(() => compileScreen("Bad.dc.html", src), /dc-import/);
});

test("T-CD-104 missing logic class fails the build", () => {
	const src = '<title>x</title><x-dc><div></div></x-dc><script type="text/x-dc">class Other {}</script>';
	assert.throws(() => compileScreen("Bad.dc.html", src), /DCLogic/);
});

test("T-CD-105 generated screens.js runs and every renderVals() succeeds", () => {
	const screens = compileAll();
	const loaded = loadScreens(screens);
	assert.equal(loaded.length, screens.length);
	for (const { meta, Component } of loaded) {
		const vals = new Component({}).renderVals();
		assert.equal(typeof vals, "object", `${meta.file} renderVals`);
	}
});

test("T-CD-106 top-level holes resolve to a value from renderVals()", () => {
	const screens = compileAll();
	const loaded = loadScreens(screens);
	for (const { meta, Component } of loaded) {
		const vals = new Component({}).renderVals();
		// Loop variables (`as="x"`) and `$index` are bound by <sc-for>, skip them.
		const aliases = new Set([...meta.template.matchAll(/\bas="([^"]+)"/g)].map((m) => m[1]));
		aliases.add("$index");
		for (const m of meta.template.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
			const head = m[1].split(".")[0];
			if (aliases.has(head) || /^(true|false|null|undefined|-?\d)/.test(head)) continue;
			assert.ok(Object.hasOwn(vals, head), `${meta.file}: {{${m[1]}}} has no value`);
		}
	}
});

test("T-CD-108 numbered titles sort numerically, else canvas order stays", () => {
	const t = (title) => ({ title });
	assert.deepEqual(
		sortByNumber([t("1 · a"), t("8 · b"), t("10 · c"), t("3 · d")]).map((s) => s.title),
		["1 · a", "3 · d", "8 · b", "10 · c"],
	);
	const mixed = [t("Main"), t("2 · x")];
	assert.deepEqual(sortByNumber(mixed), mixed);
	assert.equal(sortByNumber(compileAll())[0].file, "Main.dc.html", "start screen is artboard 1");
});

test("T-CD-107 click handlers change state and re-rendered values", () => {
	const loaded = loadScreens(compileAll());
	const main = loaded.find((s) => s.meta.file === "Main.dc.html");
	assert.ok(main, "Main.dc.html registered");
	const inst = new main.Component({});
	assert.equal(inst.renderVals().tabOdoo, false);
	inst.renderVals().tabs.find((t) => t.label.startsWith("Odoo")).pick();
	assert.equal(inst.renderVals().tabOdoo, true);
	assert.equal(inst.renderVals().stale, false);
	inst.renderVals().groups[0].items[0].toggle(); // Mailbox off -> answer is stale
	assert.equal(inst.renderVals().stale, true);
});
