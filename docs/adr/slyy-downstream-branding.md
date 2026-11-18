# Slyy downstream branding

Status: Accepted (2026-11-18)

## Context

This repository ships PI-Desktop as **Slyy** (Wapsol GmbH). The Rust host-core
and the Pi agent harness stay upstream-compatible; only the Electron app is
rebranded. Slyy must not collide with the earlier Slyy Desktop app or with a
PI-Desktop installed on the same machine, and its installation identity must
never change after the first release, or auto-update and stored data break.

## Decision

Frozen identity (guarded by `apps/desktop/test/slyy-identity-contract.test.mjs`):

| Concern | Value |
| --- | --- |
| Shown name (`APP_NAME`, `CFBundleName`, shortcuts) | `Slyy` |
| Installation name (`APP_INSTALLATION_NAME` → `app.setName`, userData, safeStorage) | `Slyy Gen2` |
| Bundle / app id (`appId`, `APP_ID`, Windows AUMID) | `ai.slyy.desktop.gen2` |
| Product / executable file name | `Slyy Gen2` (`slyy-gen2` on Linux) |
| NSIS GUID | `72db17f1-8935-5bae-870f-999d4b7621a6` |
| Data directory (passed to host-core via `PI_DESKTOP_DATA_DIR`) | `~/.slyy-gen2` (dev `~/.slyy-gen2-dev`) |
| Update feed | GitHub `mySlyy/slyy-desktop`, cache `slyy-gen2-updater` |
| macOS signing | repo variables `SLYY_APPLE_TEAM_ID`, `SLYY_MAC_SIGNING_IDENTITY` |

The "Gen2" suffix is a clean cut from the earlier Slyy Desktop app: no shared
bundle id, app file, keychain entry or data folder.

Kept on purpose (upstream contracts, harness or remote hosts depend on them):
`@pi-desktop/*` package names, `PI_DESKTOP_*` environment variables,
`pi-startup:`/`pi-genui:` protocols, localStorage keys, the
`pi-desktop-host-core` binary, `~/.pi` agent paths, remote `~/.pi-desktop/pi-host`.

The only host-core change adds `ai.slyy.desktop.gen2` and `slyy` to
`SELF_APP_KEYS` (`crates/host-core/src/computer/policy.rs`), so computer use
keeps refusing the app's own helper windows after the rename.

Visual identity follows slyy.ai through `apps/desktop/src/styles/tokens.css`
only: ink `#0a0a0a`, paper `#f4f4f2`, accent `#2b3bff` (dark-theme tint
`#7a85ff` for AA contrast), square radius ladder, Hanken Grotesk and Martian
Mono (bundled via Fontsource). UI locales: English and German (formal "Sie").

## Consequences

- No in-place upgrade path from PI-Desktop or the earlier Slyy Desktop; a
  one-time data import is planned separately.
- Windows builds stay unsigned until a code-signing certificate exists; set
  `win.publisherName` then so electron-updater verifies installers.
