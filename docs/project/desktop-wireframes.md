# Slyy Desktop wireframes build (macOS, Apple silicon)

`apps/desktop-wireframes` turns the "Slyy Desktop Wireframes" design canvas
into an installable app named **Slyy Desktop**. It shows the planned screens
and behaves like the upcoming real app around them: signed and notarized DMG,
move to Applications, in-app updates, clean-up after install and update. It
has no models, sources, host-core or backend. It shares nothing at runtime
with `apps/desktop` and does not change the real app.

Its main purpose is to exercise the whole release process end to end
(tag -> CI -> sign -> notarize -> publish -> install -> update) before the
real app goes through it.

## What it shows

The 12 artboards of the canvas, in title order (Screens menu, Cmd+1 to Cmd+9
for the first nine, Cmd+0 for the list of all screens):

1 Chat + work panel + Source Selection · 2 Why this answer · 3 Settings ›
Sources · 4 Connect a source · 5 Settings › Sharing activity · 6 Spaces ·
7 Settings › Account & devices · 8 Composer menus · 9 Scheduled · 10 Plugin
marketplace · 11 Settings › Tools · 12 Space › Tools (steward)

Clicks keep their state while you move between screens; Go › Start Over
(Cmd+Shift+R) resets them. Go › Back/Forward (Cmd+[ / Cmd+]).

## App menu (like the real app)

| Item | What it does |
| --- | --- |
| About Slyy Desktop | version |
| Check for Updates… | checks the feed; offers download, then "Restart Now" (or installs on quit). Label follows the state: Checking / Downloading / Restart to Update |
| Clean Up Installer Files… | ejects a mounted installer DMG, moves it and older `slyy-desktop-*-mac-arm64.dmg` from Downloads to the Trash, removes downloaded update files |
| Offer Clean-Up After Install and Update | on (default): the first launch of a new version offers the clean-up above (without the Downloads scan) |

First launch from the DMG offers "Move to Applications" (needed for
updates); the app relaunches from there.

Clean-up always shows the list first and acts only on "Clean Up". It touches
only files named exactly like this app's installer, volumes holding
`Slyy Desktop.app`, and the app's own update cache. Files go to the Trash
(recoverable); only the update cache is deleted. Quitting while the dialog is
open does nothing.

## How it works

- `wireframes/` holds the canvas export as-is: `canvas.json` plus one
  `*.dc.html` per artboard. This is the only design source.
- `scripts/build_screens.mjs` compiles them into `out/renderer/screens.js`:
  markup becomes a template, `<sc-for>`/`<sc-if>` become `<template>`
  elements, the logic class is wrapped in a factory. Google Fonts links are
  dropped; Hanken Grotesk and Martian Mono ship from `@fontsource-variable`.
- `src/renderer/dc_runtime.js` renders that subset of the format (holes,
  loops, conditionals, `onClick`, `setState`, links between artboards).
  Unsupported tags (`<dc-import>`, `<x-import>`) fail the build.
- `src/main/`: `main.cjs` (window, menus), `updater.cjs` (electron-updater),
  `cleanup.cjs`, `install.cjs`, `state.cjs` (`state.json`: last version,
  clean-up preference), `lifecycle_core.cjs` (pure helpers, unit-tested).
- App data: `~/Library/Application Support/ai.slyy.desktop.wireframes`, not
  `.../Slyy Desktop`, which may belong to the earlier Slyy Desktop product.
  Update cache: `~/Library/Caches/slyy-desktop-wireframes-updater`.

## Releases and updates

Own release train in `mySlyy/releases`, separate from the real app:

| Release | Contents |
| --- | --- |
| `desktop-wireframes-v<version>` | `slyy-desktop-<version>-mac-arm64.dmg` / `.zip`, blockmaps, `latest-mac.yml`, `.sha256` |
| `desktop-wireframes-channel` | only `latest-mac.yml`, replaced on every release; its URLs point at the newest versioned release |

Both are pre-releases and never "latest" (that slot is the real app's
electron-updater feed). The installed app reads
`https://github.com/mySlyy/releases/releases/download/desktop-wireframes-channel/latest-mac.yml`
(generic provider, `build.publish` in `package.json`).

`package.json` carries `"releaseTrain": "independent"`: `scripts/release.mjs`
does not bump it to the desktop version and `check:release-docs` skips it.

### Cut a release

1. Bump `version` in `apps/desktop-wireframes/package.json` (major.minor.patch),
   commit, push the branch.
2. `git tag desktop-wireframes-v<version> <commit> && git push origin desktop-wireframes-v<version>`
3. `.github/workflows/release-desktop-wireframes.yml` runs: unit tests ->
   build on the self-hosted Mac -> Developer ID signing + notarization of the
   app -> notarize + staple the DMG -> verify (codesign, Gatekeeper, staples)
   -> feed URLs made absolute (`scripts/feed_urls.mjs`) -> versioned release
   -> channel feed moved.

`workflow_dispatch` runs the same build as a dry run without publishing.

### Test an update

Install version N from its DMG, release N+1, then Slyy Desktop › Check for
Updates… in the installed N. Updates need a signed build: Squirrel.Mac only
accepts a bundle signed by the same Developer ID team.

## Update the wireframes

1. Export the canvas files (`project/canvas.json`, `project/*.dc.html`) into
   `apps/desktop-wireframes/wireframes/`, replacing the old ones.
2. `pnpm --filter @pi-desktop/desktop-wireframes test`
3. Release (above).

## Build locally

- Run unpackaged: `pnpm --filter @pi-desktop/desktop-wireframes start`
  (updates and clean-up are off outside the installed app)
- Installer: `pnpm --filter @pi-desktop/desktop-wireframes dist:mac`
  -> `apps/desktop-wireframes/release/slyy-desktop-<version>-mac-arm64.dmg`
  (signed with the keychain's Developer ID if present, not notarized)

Packaging runs the `electron-builder` of `@pi-desktop/desktop` on purpose:
declaring it in a second workspace package re-resolves part of the release
toolchain in `pnpm-lock.yaml` (plist, semver), which this app must not do.

## Security notes

- Renderer: `sandbox`, `contextIsolation`, no Node integration, DevTools only
  when unpackaged. CSP `default-src 'none'`, scripts only from the app, no
  `eval`, `connect-src 'none'`. The renderer makes no network requests.
- Wireframe logic is compiled in at build time and runs in that sandbox. Only
  import canvas exports you trust; anyone who can edit the canvas can change
  that code.
- No navigation away from the app; `https` links open in the system browser,
  all other schemes are dropped. All permission requests are denied.
- Entitlements: only `allow-jit` and `allow-unsigned-executable-memory`.
- Network: only the main process, only for updates, only HTTPS to
  `github.com` (and GitHub's download CDN).

### Man-in-the-middle risk assessment

| Path | Protection | Risk |
| --- | --- | --- |
| Update feed (`latest-mac.yml`) | HTTPS with system trust store | low |
| Update ZIP | HTTPS, sha512 from the feed, and Squirrel.Mac requires the same Developer ID team's signature | low |
| DMG download (browser) | HTTPS, Developer ID signature, notarization ticket, `.sha256` | low |
| Corporate TLS interception (trusted MITM root on the Mac) | can alter the feed, but a swapped ZIP still fails the code-signature check; worst case: updates are withheld (downgrades are refused) | low |

A compromised `SLYY_RELEASES_TOKEN` could publish a wrong feed, but not a
bundle signed by the Slyy team; keep the token scoped to `mySlyy/releases`
Contents only. Overall: low.
