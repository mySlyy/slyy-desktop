#!/usr/bin/env node
/**
 * Gateway + phone pairing E2E (E2E-GATEWAY-mobile-pairs-through-gateway):
 * boots a real `pi-host` on loopback and host-core in `--gateway` mode in
 * front of it, then acts as the Slyy phone: scans the pairing payload,
 * pairs through the gateway, reconnects with the device token, and checks
 * the phone's role ceiling and live revocation by the owner.
 *
 * Plain ws:// on loopback stands in for the TLS listener; the Rust tests
 * cover TLS (`gateway::tests::tls_listener_relays_over_wss`).
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (target/debug or PI_DESKTOP_HOST_BIN).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { parseMobilePairing } from "../packages/shared/dist/index.js";
import { errorCodeOf, shortJson } from "./e2e/assert.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/pi-host/dist/cli.js");
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
for (const [label, path] of [["pi-host cli", cli], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}
const hostBin = resolveHostBinary();
const dataDir = mkdtempSync(join(tmpdir(), "slyy-gateway-e2e-"));
const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
};
const children = [];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function spawnLogged(command, args, onLine) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine?.(line);
  });
  return { child, stderr: () => stderr };
}

function startPiHost(port, publicUrl) {
  return new Promise((resolveReady, reject) => {
    const ready = {};
    const proc = spawnLogged(process.execPath, [
      cli, "--data-dir", dataDir, "--port", String(port), "--host-core", hostBin, "--sidecar", sidecar,
      "--browse-root", dataDir, "--log-level", "warn", "--pair", "--pair-mobile", "--public-url", publicUrl,
    ], (line) => {
      const [tag, ...rest] = line.split(" ");
      const body = rest.join(" ");
      if (tag === "PI_HOST_READY") ready.info = JSON.parse(body);
      if (tag === "PI_HOST_PAIRING_TOKEN") ready.owner = JSON.parse(body);
      if (tag === "PI_HOST_MOBILE_PAIRING") ready.mobile = JSON.parse(body);
      if (tag === "PI_HOST_FAILED") reject(new Error(`pi-host failed: ${line}\n${proc.stderr().slice(-2000)}`));
      if (ready.info && ready.owner && ready.mobile) {
        clearTimeout(timer);
        resolveReady(ready);
      }
    });
    const timer = setTimeout(() => reject(new Error(`pi-host not ready\n${proc.stderr().slice(-2000)}`)), 60_000);
    proc.child.once("exit", (code) => reject(new Error(`pi-host exited code=${code}\n${proc.stderr().slice(-2000)}`)));
  });
}

async function startGateway(listenPort, upstreamPort) {
  const proc = spawnLogged(hostBin, ["--gateway", "--listen", `127.0.0.1:${listenPort}`, "--upstream", `ws://127.0.0.1:${upstreamPort}/v1/racp/ws`]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await httpGet(listenPort, "/healthz").catch(() => "")).startsWith("HTTP/1.1 200")) return proc;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway not healthy\n${proc.stderr().slice(-2000)}`);
}

function httpGet(port, path) {
  return new Promise((resolveBody, reject) => {
    const socket = tcpConnect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`));
    let body = "";
    socket.on("data", (chunk) => (body += String(chunk)));
    socket.on("end", () => resolveBody(body));
    socket.on("error", reject);
  });
}

function client(url, token) {
  return new RacpClient({
    transport: wsClientTransport({ url, token }),
    client: { name: "slyy-mobile-e2e", version: "1.0.0" },
    requestTimeoutMs: 30_000,
  });
}

async function codeOf(promise) {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return errorCodeOf(error);
  }
}

let exitCode = 0;
try {
  const [hostPort, gatewayPort] = [await freePort(), await freePort()];
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/v1/racp/ws`;
  const ready = await startPiHost(hostPort, gatewayUrl);
  await startGateway(gatewayPort, hostPort);
  record("gateway-health-is-unauthenticated", (await httpGet(gatewayPort, "/healthz")).startsWith("HTTP/1.1 200"));

  const scanned = parseMobilePairing(ready.mobile.qr);
  record("pairing-qr-parses-on-phone", scanned?.url === gatewayUrl && scanned.token.startsWith("ppt1."), shortJson(scanned));

  const pairing = client(scanned.url, scanned.token);
  const pairingInit = await pairing.connect();
  record("pairing-through-gateway-is-unprivileged", pairingInit.principal.roles.length === 0 && pairingInit.server.hostId === ready.info.hostId);
  const paired = await pairing.request("connection/pair", { deviceLabel: "e2e phone" });
  record("phone-gets-controller-and-approver", JSON.stringify(paired.roles) === '["controller","approver"]', shortJson(paired.roles));
  await pairing.close();

  const phone = client(gatewayUrl, paired.deviceToken);
  const phoneInit = await phone.connect();
  record("device-token-works-through-gateway", phoneInit.principal.subject === paired.deviceId);
  const sessions = await phone.request("session/list");
  record("phone-can-list-sessions", Array.isArray(sessions.sessions));
  record("phone-cannot-mint-devices", (await codeOf(phone.request("device/issuePairing", {}))) === "FORBIDDEN");
  record("phone-cannot-register-projects", (await codeOf(phone.request("project/register", { path: dataDir }))) === "FORBIDDEN");

  record("bad-token-refused-at-gateway", (await codeOf(client(gatewayUrl, "pdt1.not-a-device").connect())) === "REMOTE_AUTH_FAILED");
  record("reused-pairing-token-refused", (await codeOf(client(gatewayUrl, scanned.token).connect())) === "REMOTE_AUTH_FAILED");

  const owner = client(gatewayUrl, ready.owner.token);
  await owner.connect();
  const ownerDevice = await owner.request("connection/pair", { deviceLabel: "e2e desktop" });
  await owner.close();
  const desktop = client(gatewayUrl, ownerDevice.deviceToken);
  await desktop.connect();
  const listed = await desktop.request("device/list");
  record("owner-lists-phone-without-hash", listed.devices.some((d) => d.deviceId === paired.deviceId && !("tokenHash" in d)));
  const phoneClosed = new Promise((resolveClosed) => {
    const timer = setTimeout(() => resolveClosed(false), 5_000);
    phone.request("connection/ping").catch(() => undefined);
    const poll = setInterval(async () => {
      if ((await codeOf(phone.request("connection/ping"))) !== "OK") {
        clearInterval(poll);
        clearTimeout(timer);
        resolveClosed(true);
      }
    }, 100);
  });
  const revoked = await desktop.request("device/revoke", { deviceId: paired.deviceId });
  record("owner-revokes-phone", revoked.revoked === true && revoked.disconnected === 1, shortJson(revoked));
  record("revoked-phone-connection-drops", await phoneClosed);
  record("revoked-token-refused", (await codeOf(client(gatewayUrl, paired.deviceToken).connect())) === "REMOTE_AUTH_FAILED");
  await desktop.close();
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack : error);
} finally {
  for (const child of children) child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(exitCode || failed.length ? 1 : 0);
