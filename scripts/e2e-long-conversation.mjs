#!/usr/bin/env node
/**
 * E2E-LONG-CONVERSATION — a long, high-complexity conversation against a real
 * model, driven through the real desktop UI over CDP.
 *
 * The scenario protects the user-visible behaviour that only shows up after a
 * transcript becomes long: streaming stays reachable, the transcript keeps
 * rendering every turn, the composer stays responsive, the turn survives in
 * SQLite, and reopening the session restores the same history.
 *
 * Requirements (all three, from the environment or the repository `.env`):
 *   PI_DESKTOP_TEST_BASE_URL, PI_DESKTOP_TEST_MODEL, PI_DESKTOP_TEST_API_KEY
 *
 * Env knobs:
 *   PI_LONG_CHAT_TURNS          planned turns (default 110, must be >= 100 for a full run)
 *   PI_LONG_CHAT_TIMEOUT_MS     per-turn budget (default 120000)
 *   PI_LONG_CHAT_EVIDENCE_DIR   evidence directory (default .artifacts/long-conversation/<ts>)
 *   PI_LONG_CHAT_SKIP_RESTART   "1" skips the reload pass
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  let text = "";
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
loadEnvFile();

const rawBaseUrl = (process.env.PI_DESKTOP_TEST_BASE_URL ?? "").trim().replace(/\/+$/, "");
const baseUrl = rawBaseUrl.endsWith("/v1") ? rawBaseUrl : `${rawBaseUrl}/v1`;
const modelId = (process.env.PI_DESKTOP_TEST_MODEL ?? "").trim();
const apiKey = (process.env.PI_DESKTOP_TEST_API_KEY ?? "").trim();
const missing = [
  ["PI_DESKTOP_TEST_BASE_URL", rawBaseUrl],
  ["PI_DESKTOP_TEST_MODEL", modelId],
  ["PI_DESKTOP_TEST_API_KEY", apiKey],
].filter(([, value]) => !value);
if (missing.length > 0) {
  console.error(`missing required environment variables: ${missing.map(([name]) => name).join(", ")}`);
  process.exit(1);
}

const plannedTurns = Number(process.env.PI_LONG_CHAT_TURNS ?? 110);
const turnTimeoutMs = Number(process.env.PI_LONG_CHAT_TIMEOUT_MS ?? 120_000);
const artifacts =
  process.env.PI_LONG_CHAT_EVIDENCE_DIR ??
  join(root, ".artifacts", "long-conversation", String(Date.now()));
mkdirSync(join(artifacts, "workspace"), { recursive: true });
const progressPath = join(artifacts, "progress.jsonl");
const startedAt = Date.now();

const logProgress = (entry) => {
  writeFileSync(progressPath, `${JSON.stringify({ at: Date.now() - startedAt, ...entry })}\n`, {
    flag: "a",
  });
};

// Deterministic, varied, high-complexity content: every turn carries a distinct
// engineering problem plus a fresh constraint, and asks for a short answer that
// ends with a per-turn marker, so the assertion reads the model's real output
// instead of a fixture echo.
const TOPICS = [
  "Design a backpressure scheme for cross-process streaming RPC: state when data must be dropped, when the producer must block, and give the decision formula",
  "Analyse the complexity of a log parser handling 500,000 lines, name the bottleneck step and outline an O(n) replacement",
  "Write a regex that extracts every semantic version such as v1.2.3-beta.4 from mixed-language text and explain its backtracking risk",
  "Design an index scheme for multi-tenant SQLite that supports tenant, newest-first time order and status filters at once; explain the column order trade-offs",
  "Give a JSON Schema that requires objects in nested arrays to carry id/createdAt, with createdAt in RFC3339 format",
  "Analyse the race when two coroutines read and write the same Map, give minimal repro steps and compare the cost of three fixes",
  "Explain how U+2028/U+2029 are treated differently in JSON, JavaScript and regular expressions, and name the cross-language serialisation pitfalls",
  "Review the robustness of a recursive-descent parser, list three inputs that can overflow its stack and give the guards",
  "Design a crash-recovery state machine for the Electron main process with every state, transition condition and idempotency requirement",
  "Design an idempotent retry protocol: key generation, storage, expiry and conflict handling, and point out the failure window",
  "Derive the exact token count formula of a sliding-window rate limiter and compare fixed windows with a leaky bucket under bursts",
  "Design a permission model for a plugin sandbox and draw the line between least privilege, capability elevation and audit logging",
  "Compare CRDT and OT for offline collaborative editing, give the selection criteria and known counterexamples",
  "Give pseudocode for a B+ tree page split, marking the lock order for concurrency safety and the deadlock-avoidance conditions",
  "Design an end-to-end encrypted local cache: key derivation, rotation and cleanup of stale ciphertext",
  "Derive the mean waiting time of an M/M/1 queue as the arrival rate approaches the service rate and explain the numerically unstable range",
  "Design content-addressed cache keys for an incremental build system: which inputs must be hashed and which must be excluded",
  "Explain why timestamp ordering can violate causal consistency and give a vector-clock fix with its space cost",
  "Design a way to split a 10 GB file into chunks for parallel processing, covering checksums, resumable transfer and the memory ceiling",
  "Outline code that detects O(n^2) behaviour in React list rendering and give the steps to virtualise it",
  "Analyse the impact of floating-point accumulation error in financial calculations and give a fixed-point alternative with rounding rules",
  "Design backpressure and ordering guarantees for an event bus and explain how the partition key choice affects global ordering",
  "Derive the share of keys that moves under consistent hashing when nodes grow from 3 to 4, and explain how virtual nodes improve the spread",
  "Review the cycle detection of a dependency-injection container, list the cases it misses and how to fix them",
  "Design sampling for the three observability pillars in long sessions and state when a full trace must be kept",
  "Give a general transformation from tail recursion to iteration and name the languages or cases where it does not apply directly",
  "Analyse write-through versus write-back across memory/L2/disk caches and quantify the dirty-data window",
  "Design a layered compression algorithm for long-text summaries, stating what each layer keeps and which semantics it loses",
  "Explain where TLS 1.3 session resumption (PSK) breaks during mobile network handover and how to handle it",
].map((task, index) => ({ id: `T${String(index + 1).padStart(2, "0")}`, task }));

const MEMO = "MEMO-ALPHA-7";
const markerFor = (turn) => `ACK-${String(turn).padStart(3, "0")}`;
const memoProbeTurns = new Set([25, 50, 75, 100]);
const interruptTurn = 55;

function promptFor(turn) {
  const topic = TOPICS[(turn - 1) % TOPICS.length];
  const marker = markerFor(turn);
  const parts = [`Turn ${turn} of ${plannedTurns}, topic ${topic.id}: ${topic.task}.`];
  if (turn === 1) {
    parts.push(`Remember the passphrase ${MEMO} and repeat it verbatim whenever you are asked for it.`);
  }
  if (memoProbeTurns.has(turn)) {
    parts.push(`First output the passphrase from turn 1 verbatim, then answer the question.`);
  }
  if (turn === interruptTurn) {
    parts.push("In this turn give the most detailed, complete analysis you can, in several paragraphs; do not compress it into two sentences.");
  } else {
    parts.push("Constraints: at most two sentences of conclusion, no code blocks, do not restate the question.");
  }
  parts.push(`The answer must end with the marker ${marker} verbatim.`);
  return parts.join("\n");
}

const { appDir, electronBinary } = resolveElectronBinary(root);
const dataDir = join(artifacts, "data");
const profileDir = join(artifacts, "profile");
const workspace = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

// Prepare a durable session bound to the real provider, then hand the same data
// directory to the desktop so the UI exercises the production storage path.
const host = new Host(resolveHostBinary(root), dataDir);
let hostStarted = false;
let sessionId;
let providerId;
try {
  await host.start();
  hostStarted = true;
  await host.call("workspace.set", { path: workspace });
  const { provider } = await host.call("providers.create", {
    name: "Long conversation live",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl,
    authKind: "api_key_and_base_url",
    secretValue: apiKey,
    defaultModelId: modelId,
    apiStyle: "chat_completions",
    supportsReasoning: false,
    contextWindow: 128000,
    maxOutputTokens: 4096,
  });
  providerId = provider.id;
  await host.call("settings.set", {
    language: "en",
    defaultProviderId: providerId,
    defaultModelId: modelId,
    defaultMode: "agent",
    defaultPermissionMode: "auto",
    autoGenerateTitle: false,
  });
} finally {
  if (hostStarted) await host.stop();
}

const debugServer = createServer();
await new Promise((resolve) => debugServer.listen(0, "127.0.0.1", resolve));
const debugPort = debugServer.address().port;
await new Promise((resolve) => debugServer.close(resolve));

const electronEnv = {
  ...process.env,
  PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_HOST_BIN: resolveHostBinary(root),
  ELECTRON_RENDERER_URL: "",
  PI_DESKTOP_START_MAXIMIZED: "0",
};
delete electronEnv.ELECTRON_RUN_AS_NODE;

let electronOutput = "";
let child;
let ws;
let sequence = 0;
const pendingCalls = new Map();

function launchElectron() {
  electronOutput = "";
  child = spawn(
    electronBinary,
    [
      `--remote-debugging-port=${debugPort}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--user-data-dir=${profileDir}`,
      ".",
    ],
    { cwd: appDir, env: electronEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => (electronOutput += chunk));
  child.stderr.on("data", (chunk) => (electronOutput += chunk));
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`CDP timeout ${method}`));
    }, 60_000);
    pendingCalls.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression: `globalThis.__longChat = (async () => { return eval(${JSON.stringify(expression)}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
};

async function waitFor(fn, label, timeout = 30_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    if (child?.exitCode != null) {
      throw new Error(`Electron exited while waiting for ${label}: ${electronOutput.slice(-2000)}`);
    }
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

const ipc = async (name, ...args) => {
  const result = await evaluate(
    `window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}], ...${JSON.stringify(args)})`,
  );
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  return result.data;
};

const bodyText = () => evaluate("document.body.innerText");
const screenshot = async (name) => {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, "base64"));
};

async function attach() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find(
      (entry) =>
        entry.type === "page" &&
        entry.url.includes("index.html") &&
        !entry.url.includes("launcher") &&
        !entry.url.includes("plugin"),
    );
  }, "desktop CDP target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pendingCalls.get(message.id);
    if (!entry) return;
    pendingCalls.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    () =>
      evaluate(
        'Boolean(window.__PI_DESKTOP__ && window.piDesktop && !document.querySelector(".app-shell.is-booting"))',
      ),
    "desktop ready",
    60_000,
  );
  await ipc("settingsSet", { ...(await ipc("settingsGet")), language: "en", autoGenerateTitle: false });
}

async function openSession(id) {
  await evaluate(`window.__PI_DESKTOP__.refreshProviders()`);
  await evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(id)})`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".composer-input"))'), "composer ready");
}

async function watchAgentEvents() {
  await evaluate(
    `(() => { window.__longChatEvents = []; window.__longChatOff?.(); window.__longChatOff = window.piDesktop.on(window.piDesktop.channels.event.agentMessage, (event) => window.__longChatEvents.push(event)); return true; })()`,
  );
}

const readEvents = () => evaluate("window.__longChatEvents ?? []");

async function submit(text) {
  await evaluate(`(() => {
    const input = document.querySelector('.composer-input');
    input.focus();
    input.textContent = ${JSON.stringify(text)};
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.textContent }));
    return true;
  })()`);
  await waitFor(
    () => evaluate('Boolean(document.querySelector(".composer-shell .send-btn:not(:disabled)"))'),
    "send enabled",
    15_000,
  );
  await evaluate(`document.querySelector('.composer-shell .send-btn').click()`);
}

const assistantCountInStore = async () => {
  const detail = await ipc("sessionGet", { id: sessionId });
  const messages = detail.session?.messages ?? [];
  return {
    messages,
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
    last: messages.at(-1),
  };
};

const turnRecords = [];
let streamingObserved = 0;
let memoRecalled = 0;
let memoProbed = 0;
let consecutiveFailures = 0;

async function runTurn(turn) {
  const prompt = promptFor(turn);
  const marker = markerFor(turn);
  await watchAgentEvents();
  const turnStarted = Date.now();
  await submit(prompt);

  let sawStreaming = false;
  try {
    await waitFor(
      () => evaluate('Boolean(document.querySelector(".message-row.assistant.assistant-turn.streaming"))'),
      `streaming for turn ${turn}`,
      20_000,
    );
    sawStreaming = true;
  } catch {
    sawStreaming = false;
  }

  if (turn === interruptTurn) {
    await delay(2_500);
    const stopped = await evaluate(`(() => {
      const button = document.querySelector('.stop-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.ok(stopped, `stop button is reachable during turn ${turn}`);
  }

  await waitFor(
    async () => {
      const events = await readEvents();
      return events.some(
        (event) =>
          event.sessionId === sessionId &&
          (event.event?.type === "agent_end" || event.event?.type === "error"),
      );
    },
    `turn ${turn} terminal lifecycle`,
    turnTimeoutMs,
  );

  const events = await readEvents();
  const errors = events.filter((event) => event.event?.type === "error").map((event) => event.event.error);
  // `agent_end` can reach the renderer before the assistant message is durable,
  // so wait for this turn's reply to land in the store before asserting on it.
  const expectedAssistantCount = turn - (turn === interruptTurn ? 1 : 0);
  const finished =
    expectedAssistantCount > 0
      ? await waitFor(
          async () => {
            const state = await assistantCountInStore();
            return state.assistant >= expectedAssistantCount ? state : false;
          },
          `turn ${turn} durable assistant message`,
          30_000,
        )
      : await assistantCountInStore();
  const lastAssistant = [...finished.messages].reverse().find((message) => message.role === "assistant");
  const record = {
    turn,
    topic: TOPICS[(turn - 1) % TOPICS.length].id,
    seconds: Number(((Date.now() - turnStarted) / 1000).toFixed(1)),
    sawStreaming,
    errors,
    assistantCount: finished.assistant,
    userCount: finished.user,
    answered: typeof lastAssistant?.content === "string" && lastAssistant.content.includes(marker),
    interrupted: turn === interruptTurn,
    responseChars: typeof lastAssistant?.content === "string" ? lastAssistant.content.length : 0,
    memoRecalled:
      memoProbeTurns.has(turn) && typeof lastAssistant?.content === "string"
        ? lastAssistant.content.includes(MEMO)
        : null,
  };
  turnRecords.push(record);
  if (sawStreaming) streamingObserved += 1;
  if (record.memoRecalled === true) memoRecalled += 1;
  if (record.memoRecalled !== null) memoProbed += 1;
  logProgress({ kind: "turn", ...record });
  const status = record.answered ? "ok" : "no-marker";
  process.stdout.write(
    `turn ${turn}/${plannedTurns} ${status} ${record.seconds}s chars=${record.responseChars} streaming=${sawStreaming}${errors.length ? " errors=" + JSON.stringify(errors) : ""}\n`,
  );
  return record;
}

async function uiMessageRows() {
  return evaluate(`({
    user: document.querySelectorAll('.message-row.user').length,
    assistant: document.querySelectorAll('.message-row.assistant').length,
    streaming: document.querySelectorAll('.message-row.assistant.streaming').length,
  })`);
}

async function rendererRoundTripMs() {
  const start = Date.now();
  await evaluate("performance.now()");
  return Date.now() - start;
}

const responsiveness = [];
const summary = { model: modelId, baseUrl, plannedTurns, artifacts };
let restartReport = null;

try {
  launchElectron();
  await attach();
  const created = await ipc("sessionCreate", {
    title: "E2E long conversation",
    mode: "agent",
    projectPath: workspace,
    providerId,
    modelId,
    thinkingLevel: "off",
  });
  sessionId = created.session.id;
  await openSession(sessionId);
  summary.sessionId = sessionId;

  for (let turn = 1; turn <= plannedTurns; turn += 1) {
    const record = await runTurn(turn);
    if (record.answered || record.interrupted) consecutiveFailures = 0;
    else consecutiveFailures += 1;
    assert.ok(
      consecutiveFailures < 3,
      `three consecutive turns without the expected marker (last: ${JSON.stringify(record)})`,
    );
    if (turn % 10 === 0) {
      const rows = await uiMessageRows();
      responsiveness.push({ turn, roundTripMs: await rendererRoundTripMs(), rows });
      logProgress({ kind: "checkpoint", turn, rows, roundTripMs: responsiveness.at(-1).roundTripMs });
      process.stdout.write(
        `  checkpoint turn ${turn}: rows=${JSON.stringify(rows)} roundTrip=${responsiveness.at(-1).roundTripMs}ms\n`,
      );
      await screenshot(`turn-${String(turn).padStart(3, "0")}`);
    }
  }

  // Durable store: every turn is one user message plus one assistant message.
  const settled = await assistantCountInStore();
  assert.ok(
    settled.assistant >= plannedTurns - 1,
    `durable assistant messages ${settled.assistant} < turns ${plannedTurns} (interrupted turn may still be persisted)`,
  );
  assert.equal(settled.user, plannedTurns, `durable user messages ${settled.user} !== ${plannedTurns}`);

  // The transcript virtualizes long sessions: the DOM holds a window of rows
  // rather than every message, so assert the window is populated, nothing is
  // stuck streaming, and the newest replies are really rendered.
  const rows = await uiMessageRows();
  assert.ok(rows.user > 0 && rows.assistant > 0, `transcript rendered no rows: ${JSON.stringify(rows)}`);
  assert.equal(rows.streaming, 0, "no turn is left streaming after the last turn");
  const endMarkers = [markerFor(plannedTurns), markerFor(plannedTurns - 1)];
  await waitFor(
    async () => {
      const text = await bodyText();
      return endMarkers.some((marker) => text.includes(marker));
    },
    "newest replies rendered at the end of the transcript",
    30_000,
  );

  // The transcript is still usable at the end of a long session: the composer
  // accepts a draft and the run stays scrollable to the newest turn.
  await evaluate('document.querySelector(".composer-input").focus()');
  const draftOk = await evaluate(`(() => {
    const input = document.querySelector('.composer-input');
    input.textContent = 'draft-after-long-run';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'draft-after-long-run' }));
    return input.textContent === 'draft-after-long-run';
  })()`);
  assert.ok(draftOk, "composer accepts input after a long conversation");
  const lateRoundTrip = await rendererRoundTripMs();
  assert.ok(lateRoundTrip < 3_000, `renderer round trip ${lateRoundTrip}ms is unresponsive`);
  await screenshot("session-end");

  // Persistence: reopening the same data directory restores the same history.
  if (process.env.PI_LONG_CHAT_SKIP_RESTART !== "1") {
    ws.close();
    ws = undefined;
    child.kill("SIGTERM");
    await delay(2_000);
    if (child.exitCode === null) child.kill("SIGKILL");
    launchElectron();
    await attach();
    await openSession(sessionId);
    await waitFor(
      () =>
        evaluate(
          `document.body.innerText.includes(${JSON.stringify(markerFor(plannedTurns))}) || document.body.innerText.includes(${JSON.stringify(markerFor(plannedTurns - 1))})`,
        ),
      "restored newest reply rendered",
      60_000,
    );
    const restored = await uiMessageRows();
    const restoredStore = await assistantCountInStore();
    restartReport = {
      rows: restored,
      messages: restoredStore.messages.length,
      user: restoredStore.user,
      assistant: restoredStore.assistant,
    };
    assert.ok(
      restoredStore.user === plannedTurns && restoredStore.assistant >= plannedTurns - 1,
      `restored store mismatch: ${JSON.stringify(restartReport)}`,
    );
    await screenshot("session-restored");
  }

  summary.turns = turnRecords.length;
  summary.answeredTurns = turnRecords.filter((record) => record.answered).length;
  summary.streamingObserved = streamingObserved;
  summary.memoRecalled = `${memoRecalled}/${memoProbed}`;
  summary.responsiveness = responsiveness;
  summary.restart = restartReport;
  summary.totalSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  summary.slowestTurns = [...turnRecords]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5)
    .map((record) => ({ turn: record.turn, seconds: record.seconds, chars: record.responseChars }));
  summary.turnErrors = turnRecords.filter((record) => record.errors.length > 0);
  summary.interruptTurn = turnRecords.find((record) => record.interrupted) ?? null;
  const expectedAnswers = plannedTurns - (interruptTurn <= plannedTurns ? 1 : 0);
  assert.ok(
    summary.answeredTurns >= expectedAnswers,
    `only ${summary.answeredTurns}/${plannedTurns} turns returned their marker`,
  );
  assert.ok(
    streamingObserved >= Math.floor(plannedTurns * 0.6),
    `streaming was observed on only ${streamingObserved}/${plannedTurns} turns`,
  );
  writeFileSync(join(artifacts, "summary.json"), JSON.stringify({ ...summary, turnRecords }, null, 2));
  console.log("LONG_CONVERSATION_SUMMARY", JSON.stringify(summary));
  console.log("PASS E2E-LONG-CONVERSATION");
} catch (error) {
  writeFileSync(
    join(artifacts, "summary.json"),
    JSON.stringify({ ...summary, turnRecords, failure: String(error?.stack ?? error) }, null, 2),
  );
  console.error("LONG_CONVERSATION_FAILURE", error?.stack ?? error);
  if (ws?.readyState === 1) {
    await screenshot("failure").catch(() => {});
    console.error(await bodyText().catch(() => ""));
  }
  process.exitCode = 1;
} finally {
  writeFileSync(join(artifacts, "electron.log"), electronOutput);
  try {
    ws?.close();
  } catch {}
  if (child && child.exitCode === null) {
    if (process.platform === "win32") child.kill("SIGTERM");
    else child.kill("SIGTERM");
    await delay(2_000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  console.log("ARTIFACTS", artifacts);
}
