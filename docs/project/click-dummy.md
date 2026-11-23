# Wireframe click-dummy (macOS, Apple silicon)

`apps/click-dummy` is a standalone Electron app that makes the "Slyy Desktop
Wireframes" design canvas clickable as an installable app. It is a mock: no
models, no sources, no host-core, no network. It shares nothing at runtime
with `apps/desktop` and does not change the real app.

## What it shows

The 12 artboards of the canvas, in title order (Cmd+1 to Cmd+9 for the first
nine, Cmd+0 for the overview of all of them):

1 Chat + work panel + Source Selection · 2 Why this answer · 3 Settings ›
Sources · 4 Connect a source · 5 Settings › Sharing activity · 6 Spaces ·
7 Settings › Account & devices · 8 Composer menus · 9 Scheduled · 10 Plugin
marketplace · 11 Settings › Tools · 12 Space › Tools (steward)

Clicks keep their state while you move between screens. Go › Reset All
Clicks (Cmd+Shift+R) starts over. A small badge bottom right marks every
screen as a click-dummy and has back/forward.

## How it works

- `wireframes/` holds the canvas export as-is: `canvas.json` plus one
  `*.dc.html` per artboard. This is the only design source.
- `scripts/build_screens.mjs` compiles them into `out/renderer/screens.js`:
  markup becomes a template, `<sc-for>`/`<sc-if>` become `<template>`
  elements, the logic class is wrapped in a factory. Google Fonts links are
  dropped; Hanken Grotesk and Martian Mono ship from `@fontsource-variable`
  (same packages as the real app).
- `src/renderer/dc_runtime.js` renders that subset of the format (holes,
  loops, conditionals, `onClick`, `setState`, links between artboards).
  Unsupported tags (`<dc-import>`, `<x-import>`) fail the build.

## Update the wireframes

1. Export the canvas files (`project/canvas.json`, `project/*.dc.html`) into
   `apps/click-dummy/wireframes/`, replacing the old ones.
2. `pnpm --filter @pi-desktop/click-dummy test`
3. Rebuild the installer (below).

## Build and run

- Run unpackaged: `pnpm --filter @pi-desktop/click-dummy start`
- Installer: `pnpm --filter @pi-desktop/click-dummy dist:mac`
  -> `apps/click-dummy/release/slyy-click-dummy-<version>-mac-arm64.dmg`

Packaging runs the `electron-builder` of `@pi-desktop/desktop` on purpose:
declaring it in a second workspace package re-resolves part of the release
toolchain in `pnpm-lock.yaml` (plist, semver), which the dummy must not do.
So `dist:mac` needs the desktop package's dev dependencies installed.

## Signing

electron-builder signs with the Developer ID found in the login keychain, if
any. The DMG is not notarized (`mac.notarize: false`): on other Macs,
Gatekeeper asks once; open it with right-click › Open, or System Settings ›
Privacy & Security › Open Anyway. Notarize before handing it to people
outside the team.

## Security notes

- Renderer: `sandbox`, `contextIsolation`, no Node integration, DevTools only
  when unpackaged. CSP `default-src 'none'`, scripts only from the app, no
  `eval`, `connect-src 'none'`.
- Wireframe logic is compiled in at build time and runs in that sandbox. Only
  import canvas exports you trust; anyone who can edit the canvas can change
  that code.
- No navigation away from the app; `https` links open in the system browser,
  all other schemes are dropped. All permission requests are denied.
- Entitlements: only `allow-jit` and `allow-unsigned-executable-memory`.
- Man-in-the-middle: the app makes no network requests, so there is nothing
  to intercept at runtime. The remaining risk is the DMG in transit: share it
  over HTTPS only, and let recipients check the signature with
  `codesign -dv --verbose=2 "/Applications/Slyy Click-Dummy.app"`. Risk: low.
