# Vendored File Manager: scoped remote-read hotfix

This directory is the actual plugin loaded and packaged by Desktop. It now
contains the remote-read consumer required by issue #1711. It follows the
existing Desktop hotfix convention introduced by commit
`73d8932ade73471277b9a51afac90ee9867d97c8`, rather than representing an
unpublished plugin contribution as an official upstream release.

## Source and distribution provenance

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| Released reference tag | `v0.9.0` |
| Released reference commit | `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6` |
| Integration source | https://github.com/Seraph-x/pi-desktop-plugin-file-manager/tree/f47ce21fab3c59f3f4b94d30f3e3a0c8124447e1 |
| Integration commit | `f47ce21fab3c59f3f4b94d30f3e3a0c8124447e1` |
| Companion upstream proposal | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager/pull/5 |
| Bundled version | `0.9.1-pi.2` — Desktop hotfix, not an upstream release |
| License | MIT; preserve the bundled `LICENSE` and PDF.js notices |
| Locally packed runtime | `pi.file-manager-0.9.1-pi.1.piplug`, 6921923 bytes, SHA-256 `e8b6041cb5d3d4eab2b68a1e7fa61a8c7089235d9918f4a418541bd60cd109b3` |
| Marketplace publication | Not published; no marketplace artifact or accepted upstream tag is claimed for this hotfix |

The released reference tag is retained unchanged. The integration source is a
separate, immutable contribution commit. Its remote consumer uses public
`pi.fs.list` / `pi.fs.readPreview`, not local filesystem reads for opaque remote
identities. Remote editing/search/Git/watch remain unavailable explicitly.

The hotfix is strictly newer than the previous bundled `0.9.1-pi.1` (and still
than the older `0.5.3-pi.1` and marketplace `0.9.0`), so `sync_builtin` can
repair either installation. A future stable upstream `0.9.1` remains strictly
newer than the `-pi.2` prerelease and can replace it normally. The source
candidate version `0.9.1` is not reused as a supposedly released version.

## Build inputs

The recorded build used Node 24.13.0, Vite 5.4.21, TypeScript 5.9.3,
React 18.3.1 and PDF.js 6.4.299, reusing the existing plugin dependency tree.
The exact source tree and its dependency lockfiles are pinned by the integration
commit above. Native file-watch verification ran outside the filesystem sandbox
so the synthetic filesystem events could reach Node.

## Local changes from the pinned integration source

1. Apply `patches/file-manager-search-theme.patch` to
   `views-src/src/styles/index.css`, then rebuild the production view. This
   retains the theme-token search-control repair already shipped in Desktop
   by #1861 and proposed upstream in plugin PR #6. No minified JavaScript is
   edited by hand. The patch changes only CodeMirror search fields/buttons.
2. Apply `patches/file-manager-directory-location.patch` to `views-src`, then
   rebuild the production view. This is the #2113 Desktop hotfix: a host
   directory location no longer dispatches a file read (`fm.read` refuses
   directories with `INVALID_PATH`); the receiver classifies the target from
   the loaded parent listing and, for a directory, expands it, loads its
   entries and shows the tree, while a directory outside the managed roots
   keeps reporting its rejection through a localized message. The classifier
   and the failure translation are covered by the checked-in
   `views-src/verify-host-open.mjs`. No minified JavaScript is edited by hand.
3. Register `verify:host-open` in `views-src/package.json` and include it in
   the `verify` chain.
4. Set manifest version to `0.9.1-pi.2`, add `license: MIT`, and prefix its
   changelog with the Desktop hotfix description. Keep all other manifest
   declarations, permissions and safety notes from the integration source.
5. Keep Desktop's MIT `LICENSE` and `package.json` CommonJS marker. The latter
   scopes Node's module interpretation to this plugin; other bundled plugins
   retain their own module format.
6. Slyy downstream branding: after the production build, the three
   "PI-Desktop" occurrences in the no-bridge messages of
   `views/assets/index.js` (`NO_BRIDGE` error and both `errNoBridge` copies)
   are replaced with "Slyy" by exact string substitution.
7. Slyy English-only: after the production build, the `zh:` copy table is
   removed from `views/assets/index.js` (the `,zh:{title:"…",…}` member of the
   `{en:…}` copy object). Locale selection is unchanged: a Chinese host locale
   still resolves to `zh`, and the copy lookup falls back to `en` per key. The
   two Chinese `title` suffixes of Markdown preview links are replaced with
   " (click to copy; does not navigate)" and " (unsupported link protocol)".
   Third-party library code (CodeMirror bracket pairs, core-js whitespace,
   PDF.js text normalisation) keeps its non-Latin characters. `main.js`
   comments, `README.md`, `CHANGELOG.md` and the manifest display strings and
   changelog are translated to English and the manifest `i18n.zh-CN` block is
   dropped; `contributes.views[].title` is the plain string "File Manager" (a
   localized map would need both contract locales); `main.js` code tokens are
   unchanged.
   Items 6 and 7 are the only post-build edits; the patches above stay
   byte-compatible with upstream `views-src` (only their comments and test
   labels are English), so reapply both after every rebuild.

`remote-workspace.js`, `views/index.html` and
`views/assets/pdfjs-LICENSES.txt` are byte-identical to the pinned integration
commit. The manifest, rebuilt view, Desktop-local `main.js` repairs and the
English `README.md` / `CHANGELOG.md` translations differ. The runtime pack has eight
files; the two Desktop-local license/module files are added when vendoring.
QA dependencies, tests and `views-src/` are not included in the shipped plugin.
The upstream changelog contained trailing spaces; the English translation
has none, so the narrow `.gitattributes` exception for it is no longer needed.

## Shipped checksums (SHA-256)

Every runtime file, including the new remote helper and PDF license notices,
is recorded here. `UPSTREAM.md` is the provenance record, not a runtime input.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `CHANGELOG.md` | 37404 | `8a267874142932202ee5829cf8c892e69e942363a49cd5f5d4734502715ae4fb` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `README.md` | 40639 | `f267a4816c49e604233544f0d5f7f533ddeecf2876524c162399537f1564dc45` |
| `main.js` | 127762 | `0af675845951760c9766ba891e6da36d824f46c25ba325a7998c389b33b10718` |
| `manifest.json` | 33708 | `4d900c279a8e0183adb68fcff7cc2b075568d7ceb910d81efbe518e24d5cdca1` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |
| `remote-workspace.js` | 3757 | `931a579801fd4b334c3d96231aafc7ff52e0c03e7baebbabaf00b4c5e17cc366` |
| `views/assets/index.js` | 6608192 | `d47bf62c0624b6a61a4d5a39962acb67e191ac669e37ccb948c3fbd5f36cdb9a` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |

## Reproducing or updating this hotfix

1. Export the exact integration commit above as LF blobs. Reuse the plugin's
   compatible build dependencies; do not copy QA dependencies into the runtime.
2. Apply the checked-in theme and directory-location patches from the Desktop
   checkout with `git apply`.
3. Run the source typecheck, every verification script (including native file
   watching), and `vite build` in `views-src`.
4. Apply the documented manifest edits, then run
   `node scripts/prepare-package.mjs` and the official `pi-plugin check` and
   `pi-plugin pack` against `dist/runtime`. Compare unpacked artifact files to
   the installed resource files byte for byte; retain both local metadata files.
5. Refresh this provenance record and all runtime checksums. Run
   `bundled-plugins.test.mjs` and `bundled-remote-file-manager.test.mjs`, then
   `node scripts/e2e-remote-file-manager.mjs` **without** a directory argument.
   The default journey must list and read real remote fixture files through the
   actual bundled process/view, Desktop broker, RACP and Host filesystem.
6. Run the bundled light/dark editor-search journey and local edit/save controls.
   Validate the final candidate after incorporating current `origin/main`.
7. When the companion change is accepted and officially published, replace the
   integration pin with that real tag/commit and marketplace provenance; preserve
   the search-theme fix if that release does not yet contain it. Do not rewrite
   an existing upstream tag or label the local artifact as a marketplace release.

## Desktop mutation repair (#2184)

The bundled `main.js` restores file-name validation and moves
`entryFromStat` to module scope. This is a Desktop-local runtime repair;
the upstream pins and published artifact claims above are unchanged.

## Desktop Git deadline repair (#1731)

The Git timeout rejects immediately and destroys its captured output streams,
instead of waiting for a `close` event that inherited child pipes may delay.
The existing best-effort snapshot path returns unavailable Git metadata while
preserving directory listing and preview. No upstream release is claimed.
