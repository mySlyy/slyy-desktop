# Slyy gateway mode and phone pairing

Status: Accepted (2026-11-26)

## Context

Slyy runs one microVM per user: Rust host-core, pi-host (Agent Host) and the
per-workspace sandbox runner. Desktops and phones of that user reach the VM
from the internet through an SNI edge router that passes TLS through. The
architecture decision is that **no new gateway or relay process is added**:
the Rust component is the gateway, and pi-host sits behind it, shared by all
of the user's desktops and phones.

pi-host already speaks RACP-WS on loopback with device-token pairing
(security §3.4) and refuses non-loopback peers and non-loopback binds. What
was missing: a TLS listener on the VM's public port, perimeter checks before
pi-host does any work, and a way to pair a phone with fewer rights than the
owner's desktop.

The RACP spec's own "Gateway" (outbound mTLS Host link, `host/list`,
E2E-227) is a different, still unscheduled milestone. This ADR does not
implement it and does not serve `host/list`.

## Decision

1. **`pi-desktop-host-core --gateway`** is a separate process role of the
   same binary (`crates/host-core/src/gateway/`). It never opens the data
   directory or SQLite. Arguments: `--listen`, `--upstream`
   (loopback `ws://` only), `--tls-cert`/`--tls-key` (required for a
   non-loopback listen; rustls with the ring provider, TLS 1.2+ because
   Android 9 lacks TLS 1.3), `--public-host`, `--allow-origin`,
   `--max-connections`.
2. **pi-host stays the only credential authority.** The gateway checks the
   shape of the request, never the validity of a token, and stores nothing.
   Per upgrade it enforces: path `/v1/racp/ws`; no credential in the URL;
   `Host` equals `--public-host` (421 otherwise); a browser `Origin` only if
   allow-listed (native apps send none); WebSocket version 13 and the
   `pi-racp.v1.jsonrpc` subprotocol; a single `Bearer pdt1.`/`ppt1.` token of
   at most 256 bytes; a connection cap (503). Only `Authorization` and the
   subprotocol are forwarded; cookies, Origin and forwarding headers are
   dropped. pi-host's 401/403 is returned to the device unchanged.
3. **Throttle:** 10 credential failures per peer IP within 60 s answer 429
   for the rest of the window. Tokens carry 256 bits; this protects pi-host,
   not the token space.
4. **Relay:** text frames only; a binary frame closes with 1003. The gateway
   pings devices every 25 s and drops one that misses a pong. Messages above
   2 MiB are dropped; pi-host's own 1 MiB RACP limit answers below that.
5. **`/healthz`** answers 200 without authentication for the orchestrator.
6. **Phone pairing (RACP, remote-host profile, owner-only):**
   `device/issuePairing` mints a single-use token whose device receives the
   roles chosen at minting (default `controller` + `approver`; at most ten
   minutes, default five); `connection/pair` grants those roles, so a phone
   code can never yield an owner. `device/list` returns devices without the
   token hash; `device/revoke` revokes and closes that device's live
   connections (close code 4401). Pairing records without `roles` keep the
   old behaviour (owner), so `pi-host --pair` and stored records are
   unchanged.
7. **QR payload** (`packages/shared/src/mobile-pairing.ts`): compact JSON
   `{"slyy":1,"url":"wss://…/v1/racp/ws","token":"ppt1.…","exp":"…"}`, read
   only by the Slyy app. `pi-host --pair-mobile --public-url <wss-url>`
   prints it for operations; the desktop's "Pair a phone" uses
   `device/issuePairing` and the same encoder.

## Consequences

- One more process role in host-core; the desktop never starts it. Adds
  tokio-tungstenite, tokio-rustls, httparse and futures-util (all but
  tokio-tungstenite were already in the lockfile).
- Certificate rotation restarts the gateway; hot reload is future work.
- TLS terminates inside the user's VM, so the edge router never sees
  plaintext.
- Push notifications (EU push relay on the org VM) are not part of this
  slice; the phone shows approvals while connected.

## Verification

- `cargo test -p host-core gateway` — config, handshake refusals, throttle,
  relay, upstream 401 and down, binary close, TLS round trip.
- `pnpm --filter @pi-desktop/racp test`, `pnpm --filter @pi-desktop/shared test`.
- `pnpm test:e2e:gateway-mobile` — real pi-host + gateway; phone pairs,
  role ceiling holds, owner revokes it live.
