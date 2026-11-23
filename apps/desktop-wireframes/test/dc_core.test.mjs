/*
 * Unit tests of the DOM-free template helpers (src/renderer/dc_core.js).
 * IDs: T-DW-0xx (desktop wireframes).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { evalHole, interpolate, wholeHole, attrPlan, classifyHref } = require("../src/renderer/dc_core.js");

test("T-DW-001 evalHole resolves literals", () => {
	assert.equal(evalHole("true", {}), true);
	assert.equal(evalHole(" false ", {}), false);
	assert.equal(evalHole("null", {}), null);
	assert.equal(evalHole("undefined", {}), undefined);
	assert.equal(evalHole("42", {}), 42);
	assert.equal(evalHole("-1.5", {}), -1.5);
	assert.equal(evalHole("'x'", {}), "x");
	assert.equal(evalHole('"y"', {}), "y");
});

test("T-DW-002 evalHole resolves dotted paths and loop vars", () => {
	const scope = { it: { cardStyle: "a", nested: { deep: 1 } }, $index: 3, a: "Sales" };
	assert.equal(evalHole("it.cardStyle", scope), "a");
	assert.equal(evalHole("it.nested.deep", scope), 1);
	assert.equal(evalHole("$index", scope), 3);
	assert.equal(evalHole("a", scope), "Sales");
	assert.equal(evalHole("missing.path", scope), undefined);
	assert.equal(evalHole("a.length", scope), undefined, "no property access on primitives");
});

test("T-DW-003 evalHole never walks the prototype chain", () => {
	assert.equal(evalHole("constructor", {}), undefined);
	assert.equal(evalHole("it.__proto__", { it: {} }), undefined);
	assert.equal(evalHole("toString", { a: 1 }), undefined);
});

test("T-DW-004 interpolate fills holes and blanks null/undefined", () => {
	assert.equal(interpolate("Sources {{n}}/{{ total }}", { n: 4, total: 6 }), "Sources 4/6");
	assert.equal(interpolate("[{{x}}]", { x: null }), "[]");
	assert.equal(interpolate("[{{x}}]", {}), "[]");
	assert.equal(interpolate("plain", {}), "plain");
});

test("T-DW-005 wholeHole only matches a single hole", () => {
	assert.equal(wholeHole("{{ it.toggle }}"), "it.toggle");
	assert.equal(wholeHole("  {{x}} "), "x");
	assert.equal(wholeHole("a {{x}}"), null);
	assert.equal(wholeHole("{{x}}{{y}}"), null);
	assert.equal(wholeHole("literal"), null);
});

test("T-DW-006 attrPlan binds functions only on on* attributes", () => {
	const fn = () => {};
	assert.deepEqual(attrPlan("onclick", fn), { kind: "event", value: fn, event: "click" });
	assert.deepEqual(attrPlan("onClick", "alert(1)"), { kind: "skip" });
	assert.deepEqual(attrPlan("onclick", undefined), { kind: "skip" });
});

test("T-DW-007 attrPlan keeps aria booleans and drops false attributes", () => {
	assert.deepEqual(attrPlan("aria-checked", false), { kind: "set", value: "false" });
	assert.deepEqual(attrPlan("aria-pressed", true), { kind: "set", value: "true" });
	assert.deepEqual(attrPlan("aria-label", undefined), { kind: "skip" });
	assert.deepEqual(attrPlan("disabled", false), { kind: "skip" });
	assert.deepEqual(attrPlan("disabled", true), { kind: "set", value: "" });
	assert.deepEqual(attrPlan("style", "color: red"), { kind: "set", value: "color: red" });
	assert.deepEqual(attrPlan("tabindex", 0), { kind: "set", value: "0" });
});

test("T-DW-008 classifyHref routes wireframe links", () => {
	assert.deepEqual(classifyHref("#"), { kind: "noop" });
	assert.deepEqual(classifyHref(""), { kind: "noop" });
	assert.deepEqual(classifyHref("#top"), { kind: "anchor", target: "top" });
	assert.deepEqual(classifyHref("Spaces.dc.html"), { kind: "screen", target: "Spaces.dc.html" });
	assert.deepEqual(classifyHref("/Main.dc.html"), { kind: "screen", target: "Main.dc.html" });
	assert.deepEqual(classifyHref("https://slyy.ai"), { kind: "external", target: "https://slyy.ai" });
});

test("T-DW-009 classifyHref blocks unsafe or unknown schemes", () => {
	for (const h of ["javascript:alert(1)", "http://example.com", "file:///etc/passwd", "../x.dc.html", "data:text/html,x"]) {
		assert.deepEqual(classifyHref(h), { kind: "blocked" }, h);
	}
});
