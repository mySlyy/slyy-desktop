import assert from "node:assert/strict";
import test from "node:test";
import { SessionSearchController, searchMatchRanges } from "../src/lib/session-search.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function hit(id) {
  return { session: { id }, messageCount: 1, matches: [] };
}

test("literal highlighting agrees with host Unicode folding and preserves UTF-16 offsets", () => {
  for (const [text, query, expected] of [
    [
      "\u{1f600} \u4e2d\u6587 \u4e2d\u6587",
      "\u4e2d\u6587",
      [
        [3, 5],
        [6, 8],
      ],
    ],
    [
      "a MiXeD mixed",
      "mixed",
      [
        [2, 7],
        [8, 13],
      ],
    ],
    ["100% a_b C:\\path", "%", [[3, 4]]],
    [
      "\u00c4 \u00e4",
      "\u00e4",
      [
        [0, 1],
        [2, 3],
      ],
    ],
    ["x", "   ", []],
    ["\u4e2d", "\u4e2d", [[0, 1]]],
    ["\u0130 prefix \u4e2d\u6587", "\u4e2d\u6587", [[9, 11]]],
    ["\u0130 XX", "xx", [[2, 4]]],
    ["\u0130", "\u0307", [[0, 1]]],
    ["W\u00d6RTER", "w\u00f6rter", [[0, 6]]],
  ])
    assert.deepEqual(searchMatchRanges(text, query), expected);
});

test("older queries and closed palettes cannot publish asynchronous results", async () => {
  const old = deferred();
  const current = deferred();
  const controller = new SessionSearchController((query) =>
    query === "old" ? old.promise : current.promise,
  );
  controller.reset("old");
  const a = controller.load();
  controller.reset("new");
  const b = controller.load();
  current.resolve({ hits: [hit("new")], nextOffset: null });
  await b;
  old.resolve({ hits: [hit("old")], nextOffset: 30 });
  await a;
  assert.deepEqual(
    controller.getSnapshot().hits.map((entry) => entry.session.id),
    ["new"],
  );

  const closing = deferred();
  const closed = new SessionSearchController(() => closing.promise);
  closed.reset("closing");
  const load = closed.load();
  closed.cancel();
  closing.resolve({ hits: [hit("late")], nextOffset: null });
  await load;
  assert.deepEqual(closed.getSnapshot().hits, []);
  assert.equal(closed.getSnapshot().loading, false);
});

test("pagination appends sessions once and its stale errors do not replace the next query", async () => {
  const later = deferred();
  const controller = new SessionSearchController(async (query, offset) => {
    if (query === "new") return { hits: [hit("new")], nextOffset: null };
    if (!offset) return { hits: [hit("one")], nextOffset: 30 };
    return later.promise;
  });
  controller.reset("first");
  await controller.load();
  const page = controller.load(30);
  later.resolve({ hits: [hit("one"), hit("two")], nextOffset: 60 });
  await page;
  assert.deepEqual(
    controller.getSnapshot().hits.map((entry) => entry.session.id),
    ["one", "two"],
  );
  assert.equal(controller.getSnapshot().nextOffset, 60);

  const failure = deferred();
  const rejecting = new SessionSearchController((query) =>
    query === "old"
      ? failure.promise
      : Promise.resolve({ hits: [hit("new")], nextOffset: null }),
  );
  rejecting.reset("old");
  const old = rejecting.load();
  rejecting.reset("new");
  await rejecting.load();
  failure.reject(new Error("stale"));
  await old;
  assert.equal(rejecting.getSnapshot().error, undefined);
  assert.equal(rejecting.getSnapshot().hits[0].session.id, "new");
});

test("a failed request is observable and can be retried", async () => {
  let tries = 0;
  const controller = new SessionSearchController(async () => {
    if (!tries++) throw new Error("offline");
    return { hits: [hit("recovered")], nextOffset: null };
  });
  controller.reset("query");
  await controller.load();
  assert.equal(controller.getSnapshot().error, "offline");
  await controller.load();
  assert.equal(controller.getSnapshot().error, undefined);
  assert.equal(controller.getSnapshot().hits.length, 1);
});
