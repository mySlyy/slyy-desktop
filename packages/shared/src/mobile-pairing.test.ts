import { describe, expect, it } from "vitest";

import { encodeMobilePairing, isMobileRacpEndpoint, parseMobilePairing } from "./mobile-pairing.js";

const token = "ppt1.AbCdEfGhIjKlMnOpQrStUvWx";

describe("mobile pairing payload", () => {
  it("round-trips through the compact QR form", () => {
    const payload = { url: "wss://anna.wapsol.slyy.ai/v1/racp/ws", token, expiresAt: "2026-11-26T10:05:00.000Z" };
    const encoded = encodeMobilePairing(payload);
    expect(encoded).toBe(`{"slyy":1,"url":"wss://anna.wapsol.slyy.ai/v1/racp/ws","token":"${token}","exp":"2026-11-26T10:05:00.000Z"}`);
    expect(parseMobilePairing(encoded)).toEqual(payload);
  });

  it("accepts only TLS endpoints, except loopback for development", () => {
    expect(isMobileRacpEndpoint("wss://anna.wapsol.slyy.ai/v1/racp/ws")).toBe(true);
    expect(isMobileRacpEndpoint("ws://127.0.0.1:8443/v1/racp/ws")).toBe(true);
    expect(isMobileRacpEndpoint("ws://anna.wapsol.slyy.ai/v1/racp/ws")).toBe(false);
    expect(isMobileRacpEndpoint("wss://anna.wapsol.slyy.ai/other")).toBe(false);
    expect(isMobileRacpEndpoint("wss://anna.wapsol.slyy.ai/v1/racp/ws?token=x")).toBe(false);
    expect(isMobileRacpEndpoint("wss://user:pw@anna.wapsol.slyy.ai/v1/racp/ws")).toBe(false);
  });

  it("refuses device tokens, extra keys and other versions", () => {
    const base = { slyy: 1, url: "wss://a.slyy.ai/v1/racp/ws", token, exp: "2026-11-26T10:05:00.000Z" };
    expect(parseMobilePairing(JSON.stringify(base))).not.toBeNull();
    expect(parseMobilePairing(JSON.stringify({ ...base, token: "pdt1.AbCdEfGhIjKlMnOpQrStUvWx" }))).toBeNull();
    expect(parseMobilePairing(JSON.stringify({ ...base, slyy: 2 }))).toBeNull();
    expect(parseMobilePairing(JSON.stringify({ ...base, extra: true }))).toBeNull();
    expect(parseMobilePairing("not json")).toBeNull();
    expect(() => encodeMobilePairing({ url: "https://a.slyy.ai/v1/racp/ws", token, expiresAt: base.exp })).toThrow();
  });
});
