import { RACP_PAIRING_TOKEN_PREFIX, RACP_WS_PATH } from "./racp.js";

/**
 * What a Slyy phone scans to pair (docs/adr/slyy-gateway-mode.md). The QR
 * code is read only by the Slyy app, never opened as a link, so the
 * single-use pairing token may travel in it; it is useless after one
 * exchange or once `expiresAt` passes.
 *
 * Wire form: compact JSON `{"slyy":1,"url":…,"token":…,"exp":…}`.
 */
export type MobilePairingPayload = {
  /** The user's gateway, e.g. `wss://anna.wapsol.slyy.ai/v1/racp/ws`. */
  url: string;
  token: string;
  expiresAt: string;
};

export const MOBILE_PAIRING_VERSION = 1 as const;
const MAX_PAYLOAD_CHARS = 1024;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** `wss://<host>/v1/racp/ws`, or plain `ws://` on loopback for development. */
export function isMobileRacpEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.pathname !== RACP_WS_PATH || url.search || url.hash || url.username || url.password) return false;
  if (url.protocol === "wss:") return url.hostname.length > 0;
  return url.protocol === "ws:" && isLoopbackHost(url.hostname);
}

export function encodeMobilePairing(payload: MobilePairingPayload): string {
  if (!isMobileRacpEndpoint(payload.url)) throw new Error("pairing URL must be wss://<host>/v1/racp/ws");
  if (!payload.token.startsWith(RACP_PAIRING_TOKEN_PREFIX)) throw new Error("not a pairing token");
  return JSON.stringify({ slyy: MOBILE_PAIRING_VERSION, url: payload.url, token: payload.token, exp: payload.expiresAt });
}

/** Strict parse: unknown versions, extra keys, or a non-pairing token are refused. */
export function parseMobilePairing(text: string): MobilePairingPayload | null {
  if (text.length > MAX_PAYLOAD_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "exp,slyy,token,url" || record.slyy !== MOBILE_PAIRING_VERSION) return null;
  const { url, token, exp } = record;
  if (typeof url !== "string" || typeof token !== "string" || typeof exp !== "string") return null;
  if (!isMobileRacpEndpoint(url) || !/^ppt1\.[A-Za-z0-9_-]{16,128}$/.test(token) || Number.isNaN(Date.parse(exp))) return null;
  return { url, token, expiresAt: exp };
}
