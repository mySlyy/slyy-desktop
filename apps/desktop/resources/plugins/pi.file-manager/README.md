# File Manager

## SSH workspaces

Remote directory browsing and text/image previews use the Host's scoped
`pi.fs.list` / `pi.fs.readPreview` service, rather than this computer's Node
filesystem. The panel labels remote projects as read-only. Text previews are
limited to 512 KiB and images to 5 MiB; unsupported and oversized files report
their status explicitly. Search, Git, watch, editing and local application
actions are unavailable remotely. Returning to a local project restores the
ordinary local features. Failed directory requests show their error and a Retry
button instead of remaining on Loading.

This requires Desktop remote workspace metadata and the paired Host's
`workspacePluginFiles` capability from the companion fix for
[PI-Desktop #1711](https://github.com/vastsa/PI-Desktop/issues/1711). Older Hosts
report an upgrade error; remote requests never substitute local files. Local
projects remain compatible with the existing minimum Desktop version.

Run `pnpm verify:remote` and `pnpm verify:tree` in `views-src` for isolated
regressions. Cross-repository Electron validation runs the production view and
plugin process through Desktop's broker, a loopback RACP server and the real
Host filesystem service; see `scripts/e2e-remote-file-manager.mjs` in the
companion Desktop branch. It does not connect to user SSH servers or profiles.

### Paired release for #1711

Version 0.9.1 keeps this repair distinct from the existing v0.9.0 tag.
Delivery through the companion
[Desktop PR #1824](https://github.com/vastsa/PI-Desktop/pull/1824) requires a
plugin release and a bundled update. Tag the accepted plugin commit and
publish the same runtime bytes to the marketplace; preserve the existing
v0.9.0 tag.

Prepare the runtime with `node scripts/prepare-package.mjs`, then run the
official `pi-plugin check dist/runtime` and `pi-plugin pack dist/runtime`.
The runtime includes `remote-workspace.js` and
`views/assets/pdfjs-LICENSES.txt` as well as the main process, manifest,
built view, README and changelog; omitting either new runtime file makes the
vendored update incomplete.

After publication, Desktop must copy the released runtime, preserve its local
MIT license and CommonJS marker, and update `UPSTREAM.md` and the bundled
provenance tests using the real tag, commit, marketplace artifact checksum
and per-file checksums. Run the cross-repository Electron journey against
`apps/desktop/resources/plugins/pi.file-manager` on the updated Desktop PR
integration candidate. A separate development-plugin run does not validate
the shipped bundle.

Browse, view and edit the current project's files in the Desktop **right work
panel**: a full directory tree (icons per file type), a split layout (the left
file list can be collapsed as a whole), syntax-highlighted editing and saving,
PDF previews, image and media viewing, CSV/JSON structured views, switching the
browsed folder when a project registers several local folders (remembered per
project), plus create, rename/move, copy path from the context menu, **Open
with…** (a submenu listing the programs actually installed on this machine,
filtered by file type), filename search, **git integration** (the file list
marks modified and new files, and shows a file's changes against the last
commit line by line) and **file watching** (files changed outside the editor
are re-read and the list refreshes automatically). The host can also ask the
view to open a file directly, including paths it picked outside the project
(session scratch directory / attachments).

## Features

- **Full directory tree**: lazy-loaded, expandable per level, folders first.
  Each row's icon follows the file type (folder, code, JSON, Markdown, styles,
  HTML/Vue/Svelte, YAML/TOML, shell, SQL, images, archives, fonts, lock files
  and more each have their own glyph and colour); special names such as
  `package.json`, `Dockerfile`, `LICENSE`, `.gitignore` win over the extension.
- **Selected and hover states are distinct**: hover is a faint neutral tint
  (mouse position only); selection is an accent background + accent bar on the
  left + foreground text + medium weight, kept when the mouse leaves, and one
  step darker when hovered, so a selection never looks lost.
- **Context menu**: grouped as open with, create, file management, copy path,
  view changes / show in folder, refresh. HTML, HTM and XHTML files can pick the
  host's built-in browser under "Open with…". Empty list space offers only
  create and refresh; files and folders show type-specific actions. Supports
  ↑↓ / Home / End / Enter / Esc; items with a submenu expand on hover, `→`
  enters and `←` goes back one level.
- **Copy relative path / copy absolute path**: right-click any file or folder.
  The relative path is based on the currently browsed folder (forward slashes);
  the absolute path is the full path ready to paste elsewhere (built from that
  folder when the base is not the primary one). Success and failure each show a
  toast with the copied content; nothing fails silently.
- **Open with… (submenu)**: expands on hover and lists programs **actually
  installed on this machine**: the system default app, plus VS Code, Zed,
  Chrome, Edge and similar (only those present). Picking one opens the current
  entry in it. **Filtered by file type**: editors open anything (files and
  folders); browsers appear only for web files they can render (`.html` /
  `.htm` / `.shtml` / `.xhtml` / `.mhtml` / `.svg` / `.pdf` / `.xml`); opening
  `App.tsx` in Chrome would only show a plain-text page, so it is not listed.
  Detection runs once at startup and is **cached per day** (a second window or
  second launch on the same machine and day reads that cache) and **never walks
  directories**: it only reads the `App Paths` and `StartMenuInternet` registry
  keys, looks up candidate command names on `PATH`, and `stat`s a few fixed
  install locations once each; every step is O(candidates). When nothing is
  found only "System default app" remains, never an entry that does nothing.
- **Split layout, collapsible left list**: file list on the left, content on
  the right. The divider can be dragged and its width is remembered; the
  leftmost toolbar button collapses the whole left side (the editor then fills
  the panel; expanding restores the previous width; the collapsed state is
  remembered). A host open request collapses it automatically; once you expand
  it manually it stays expanded until the next host request.
- **Switching folders in a project group**: when the host registers a project
  as several local folders (`workspace.get` / initial handshake `roots`,
  `projectId`), the folder name at the top left is the switcher: it opens a menu
  of the group's folders, marking the primary folder and checking the current
  one; keyboard accessible (`aria-haspopup` / `aria-expanded`, Escape or a click
  outside closes it) and usable while the tree is collapsed. **With a single
  folder (or an older host that sends no group info) the header is unchanged**,
  with no dead entry. Switching resets tree, expansion, selection, search and
  open files, and still asks for confirmation on unsaved changes first;
  cancelling changes nothing. The browsed folder is **remembered per project**
  (keyed by `projectId` when the host provides one, otherwise by the primary
  folder path; a remembered path is trusted only if it matches a current root,
  otherwise the primary folder is used; at most 20 projects, evicted by most
  recent write); new projects start at the primary folder.
- **Syntax-highlighted editing**: CodeMirror 6 with line numbers, find/replace,
  multiple cursors, bracket matching and code folding. The language is picked
  from the file name, covering TypeScript/TSX, JavaScript/JSX, JSON, Markdown,
  CSS/SCSS/Sass/Less, HTML, Vue, XML, YAML, TOML, Properties, Python, Go, Rust,
  Java, C/C++, C#, Kotlin, Scala, Dart, Objective-C, PHP, Ruby, Lua, Shell,
  PowerShell, SQL, Dockerfile and Diff. All bundled and offline; no network
  requests. Save with `Ctrl/Cmd+S` or the toolbar button; **nothing is written
  without changes**; after saving, cursor and scroll position stay put, and the
  UI always shows what is on disk. `Ctrl/Cmd+S` also works when focus is not in
  the editor (toolbar, preview, table or tree).
- **Markdown preview / edit toggle**: for `.md` / `.markdown` / `.mdx` the
  toolbar shows an "Edit / Preview" toggle. The preview supports headings,
  fenced code blocks (same highlighting), quotes, rules, ordered / unordered /
  task lists (nested by indentation), tables (with alignment), inline code,
  bold, italic, strikethrough, links and images. The choice is remembered.
- **PDF preview (read-only)**: `.pdf` opens with continuous vertical scrolling,
  "single / double / double with separate cover" layouts, previous / next page,
  page number input, zoom (10%-400%), fit width and 100% actual size. Fit width
  follows the panel and split sizes, computed from the widest known page group
  of the current layout. Scrolling keeps proportions; a lone cover or last page
  is not enlarged; lazy loading that discovers a wider page widens the basis.
  "Navigation" opens a sidebar: **thumbnails** locate pages and mark the current
  one, **outline** shows the PDF's nested bookmarks and jumps to them,
  **document info** shows file name, size, page count, title, author, dates and
  other metadata; a missing outline is stated explicitly. PDFs with a text layer
  allow selecting and copying text and full-text search (match highlighting and
  count for Latin and CJK text, previous / next match, combinable toggles for
  match case, whole word and regular expression; an invalid regex is reported
  and clears matches until fixed; Enter / Shift+Enter navigate, Escape closes);
  clearing or closing removes highlights. Ctrl/Cmd+F opens find when focus is in
  the PDF reader. Scans show the original image, without OCR. PDF.js, the
  worker, font maps and image / colour decoders are bundled and work offline.
  The main view caches nearby pages, thumbnails render only the visible range
  and release unused page resources; on narrow panels the navigation sidebar
  overlays, closes after a jump, and also closes with Escape. Switching files
  releases the document and worker; the per-file limit is **24 MiB**.

  Regex search runs per page in a separate worker without re-parsing the PDF;
  if one page takes over 1 second or yields more than 100,000 matches, the
  search stops, clears its matches and shows a notice; simplify the expression
  and search again. Clearing, closing, switching search mode or document
  cancels the old task. If the worker hangs, document teardown waits at most 1
  second and still cleans up that document's fonts, filters and listeners.
- **Image viewing**: png / jpg / jpeg / gif / webp / avif / bmp / ico / svg.
  Fit to window by default, switchable to "actual size"; pixel dimensions and
  file size at the bottom, checkerboard stage so transparency is visible.
- **Audio and video**: mp4 / m4v / mov / webm / ogv / mkv use a player, mp3 /
  m4a / aac / wav / flac / ogg / opus / weba an audio bar. **No autoplay**; an
  unsupported codec or container shows a clear message instead of a black box.
- **CSV / TSV tables (paged)**: `.csv` / `.tsv` open as a table with **1000
  rows per page** by default; the bottom bar pages (first / previous / next /
  last), shows "current range / total rows" and changes the page size
  (100-5000, remembered). The first row is a sticky header, the leftmost column
  is a sticky row number, rows highlight on hover, all-numeric columns are
  right-aligned, and ellipsis-truncated values show in full on hover. **Click a
  header to sort**: ascending, descending, off (file order); all-numeric
  columns compare numerically, otherwise natural text order, empty values
  always last. The parser handles quoting, `""` escapes, newlines in fields,
  CRLF and ragged rows; at most 60 columns and 200,000 rows, with a note when
  exceeded. The toolbar switches back to source editing.
- **JSON tree**: `.json` / `.jsonc` / `.json5` can switch to a tree view,
  expanded two levels by default, at most 100 keys shown directly per node,
  long strings truncated (full value in the tooltip). Non-strict JSON such as
  `//` comments or trailing commas does not break the panel; it shows "parse
  failed + reason" and the source view stays editable.
- **SQLite databases (read-only)**: `.db` / `.sqlite` / `.sqlite3` / `.db3`
  open directly: an overview at the top (size, page size x page count,
  encoding, SQLite library version, WAL notice), a "Browse" tab to view a table
  or view (paged, sortable headers, leftmost `rowid`, `NULL` greyed out, BLOBs
  shown by size only), a "Structure" button for columns and types / indexes /
  triggers / the original `CREATE`, and an "SQL" tab with a **read-only query
  box** (`Ctrl/Cmd+Enter` runs, optional row limit, shows duration and
  truncation).
  This is the **only preview type that can open large files**: database bytes
  never reach the view; the main process fetches one page at a time.
- **Binaries are labelled**: files without a previewable form, such as zip /
  apk / exe, show "Binary file (zip, apk, exe, etc.), preview not supported";
  no magic sniffing, no pretending to unpack.
- **File operations**: new file, new folder, rename, move to a chosen folder.
- **Open with default app / show in folder**: from a file's context menu
  (`fs.openDefault` / `fs.reveal`). Both actions are executed by the host with
  the same permission and scope as the built-in Files view. After switching
  folders, when the base is not the primary folder, an absolute path is sent:
  these host channels only accept workspace-relative paths, which would be
  resolved against the primary folder and could open a same-named file in the
  other folder; the host has a matching narrow allowance for absolute paths
  under the project's registered folder roots (ADR 0253).
- **Filename search**: paged search across the whole project; clicking a result
  jumps to and expands the file.
- **Host open requests**: the host can ask the view to open a file; both
  delivery paths (the `?piViewOpen=` payload of the view entry URL and the
  `view:open` push) are handled, and a duplicate delivery of the same request is
  processed once. Each path form has its own base: **project-relative paths**
  use the primary folder (switching back to it first if another folder is
  shown); **absolute paths under another root of the same project** switch to
  the containing root first and open relative to it (ancestors expanded, row
  highlighted, same as clicking a search result); **absolute paths outside the
  group** (session scratch directory / attachments) keep the 0.4.0 external
  behaviour: not in the tree, no row highlighted, base unchanged. Unsaved
  changes are still confirmed first; edits are never discarded silently.
- **Git integration (status + changes)**: every file row carries a git badge:
  **green `A` added** (including untracked new files), **amber `M` modified**,
  **red `D` deleted**, **blue `R` renamed**, **purple `U` conflicted**; the end
  of the row shows added/removed line counts against the last commit (`+N` /
  `−N`). **Folders show a rollup of their whole subtree** (the most notable
  status + number of affected files), so a dirty folder is visible without
  expanding it. Hover shows the full description (staged or not, untracked or
  not). The top of the left list summarises the current branch and the number
  of files per change kind ("Working tree clean" when clean).
  For a changed file, the toolbar shows a "Changes" button (also "View changes"
  in the context menu) that opens a **line-by-line unified diff**: added lines
  green, removed lines red, line numbers on both sides, hunk headers keep the
  enclosing function name, and **staged (HEAD → index) and unstaged (index →
  disk) sections are labelled separately**; untracked new files show as
  all-added, and deleted files still show what was removed. Badges and diffs
  update immediately after saving (the main process snapshot is invalidated).
  Status and diffs come from the **real git in the working copy** (read-only
  subcommands `status` / `diff` / `rev-parse`; no index writes, no network,
  nothing inside `.git/**`), so index format, rename detection and
  `.gitattributes` line-ending and filter normalisation follow the user's git
  version and always match `git status`. **Without git, outside a repository,
  or when git times out or is missing, all marks disappear**; listing, reading,
  writing, saving and deleting are unaffected.
- **File watching (auto-refresh)**: files changed outside this view (another
  editor, `git checkout`, build output, another window) are detected within
  about a second and **re-read**, and the tree and list refresh (size, mtime,
  git badges, created and deleted entries) without pressing "Refresh". The
  main process opens one recursive Node `fs.watch` on the **currently browsed
  folder** (`persistent: false`, so the panel never keeps a background process
  alive; events under `.git/` and `node_modules/` are dropped, credential paths
  are never reported); changes are debounced for 250ms into a bounded history
  and the view fetches the delta every 1.2 seconds (the host gives plugins no
  push channel to a view; the round is skipped while the panel is hidden).
  Three explicit rules: (1) an open file is re-read automatically **only
  without unsaved changes; with unsaved changes only a notice bar appears and
  nothing is overwritten** (silently discarding what was just typed is the
  worst kind of automation); the bar's "Reload" still goes through the existing
  unsaved-changes confirmation; (2) the plugin's own saves are noted first, and
  an event for the same path within 1.5 seconds does not count as an external
  change, otherwise every `Ctrl+S` would reload your own document (losing cursor
  and scroll position); (3) a bulk change refreshes at most 8 folders, the rest
  is left for the next round or a manual refresh.
  An "Auto-refresh" switch at the top turns it off at any time (the button is
  disabled with an explanation when the runtime cannot watch recursively);
  **both manual refresh buttons are unchanged**: watching only saves a click,
  it never replaces them. The watcher follows project / folder switches and is
  closed when the plugin unloads.
- **Edit / Preview / Changes are one mutually exclusive tab group**: for a file
  with git changes, the toolbar is a single tablist in which "Changes" sits
  with "Edit / Preview", so it is reachable from either side and back, and the
  content area **only ever shows one view** (in 0.8.0 "Changes" was a separate
  toggle outside the tablist, so "Preview + Changes" could be active together
  and two full-height views overlapped; since 0.8.1 the single-valued
  `contentKind()` in `lib/pane.ts` makes this impossible). The Changes tab is
  offered for text files only.
- **Ignore rules**: if the project has a `.gitignore` / `.ignore`, matching
  entries are hidden (the eye button in the toolbar shows them again); **with
  no rule file at all, the tree shows every entry**.
- **Follows the host appearance**: light/dark colours and UI language follow
  the Desktop shell, including the editor and preview highlighting.

## Installation

On the Desktop Plugins page:

1. **Load development plugin** and choose this directory; or
2. use **Install plugin package** with a `.piplug` package. After updating,
   close and reopen the whole File Manager tab, or restart Desktop, so the view
   loads the new code; the refresh button of a PDF only re-reads the document.

Then open a project and click "File Manager" in the **"Plugin views"** group of
the switcher menu in the right work panel header.

> This plugin has no command palette entry and registers no panel window; it
> only provides a view docked in the right sidebar (`contributes.views`). The
> host offers no "open a view by command" channel, so no misleading command is
> declared.

## Development

```bash
cd views-src
pnpm install
pnpm typecheck
pnpm build      # output goes to ../views (checked in; the host loads views/index.html)
```

`views-src` is the source (React + TypeScript + Tailwind + CodeMirror 6);
`views` is the build output and is checked in. The build is a **single IIFE
file** with all dynamic imports inlined: the host loads the view over
`file://`, where Chromium blocks `type="module"` and `crossorigin`, so the
`fileProtocolCompat` plugin in `vite.config.ts` rewrites `index.html`.

PDF uses the `pdfjs-dist` compatibility build and the multi-page `PDFViewer`;
`pdf-assets-plugin.ts` embeds the classic worker, CMaps, standard fonts, WASM
and ICC resources into the output. `lib/pdfViewer.ts` handles continuous
scrolling, double-page layouts, zoom and page caching; `lib/pdfFit.ts`
separately records the widest known page group per layout so fit width does not
depend on the scrolled page, collecting only page sizes PDF.js has already
initialised instead of prefetching the whole document. `PdfSidebar.tsx`
provides virtualised thumbnails, outline and metadata, reusing the main view's
cleanup events so pages on screen are not released. Resource reads inside the
worker map to data URLs, so no CDN, local server or module loading under
`file://` is needed; `https://pi-file-manager.invalid/pdfjs/` in the source is
only an in-bundle resource identifier and is never fetched.

`pdf-find-plugin.ts` adds async waiting and stale-result protection to the find
interface of the pinned PDF.js version, with the regex worker bundled in the
IIFE; `pdf-lifecycle-plugin.ts` adds bounded waits and front-end resource
cleanup to the main API's startup, page cancellation and teardown. Both check
the version and a unique source anchor and must be re-checked after a library
upgrade.

Desktop PDF and file-watch regression checks are described in
`tests/electron/README.md`; they run an isolated Electron instance with
synthetic documents against the real production `file://` UI and check
resource release. Run them when changing related behaviour.

`main.js` is hand-written, dependency-free CommonJS; plugin dependencies are
not installed, so never `require` third-party packages from it.

### Packaging

After building and the desktop checks, run `node scripts/prepare-package.mjs`
in the repository root. It creates `dist/runtime` and copies only
`manifest.json`, `main.js`, the production `views/` (with third-party
licences), README and CHANGELOG; sources, test fixtures, QA scripts and
dependencies stay out of the runtime package.

Then run the official Desktop `PluginCheck` and `PluginPack` against
**`dist/runtime`**. Development loading can still use the repository root; the
release package uses the prepared runtime directory so the whole test tree is
not packed.

### Verification

```bash
cd views-src
pnpm typecheck
pnpm verify        # project group / path jail + highlighting + Markdown + viewers + git + watch + PDF
```

`pnpm verify` runs nine DOM-free verification scripts covering nine paths that
would otherwise fail silently:

- **`verify-roots.mjs`**: asserts the pure rules in `lib/roots.ts`: group shape
  (older hosts degrade to a single root, names fall back to the last path
  segment, `primary` flag and order), memory keys (`p:` / `r:`), the selected
  root (memory is trusted only on a match; a folder with a prefix-related name
  such as `Beta-old` does not match), bounded LRU memory and "rewrite moves to
  the end". Finally it cross-checks the same-named constant and memory key
  prefix in `main.js`: view and main process are two independent
  implementations, and drift would make the UI and the jail resolve against
  different bases.
- **`verify-jail.mjs`**: a stub host drives the **real `main.js`** on a
  two-folder project where the selected root is not the primary one, and
  asserts the containment base as an observable: after switching to the
  sibling folder the tree and root-relative reads follow, primary-root files
  are not readable root-relative from the sibling, `..` and credential files
  are still refused, an absolute path under another registered root is
  normalised within the group instead of treated as external, the base stays
  on the remembered folder after eviction and single-key writes, and older
  hosts without `roots` still work.
- **`verify-highlight.mjs`**: runs 17 real files through the full
  `file name → language resolution → load → syntax tree → highlight tokens`
  chain, asserting each yields enough distinct highlight classes, and
  conversely that `.txt` / `.bin` / `.zip` / `.png` / `LICENSE` are not
  claimed. CodeMirror highlighting reports nothing when it cannot parse, so
  grepping the build output misses runtime problems (the first version of this
  plugin hit exactly that: the fallback highlighter from `basicSetup` overrode
  its own styles).
- **`verify-markdown.mjs`**: asserts the element tree the preview really
  produces (headings / lists / tables / task lists / nested emphasis), the link
  protocol allowlist, the **absence of `dangerouslySetInnerHTML`** and that raw
  HTML is escaped. One regression case guards against sharing a `g`-flagged
  regex across recursive inline parsing, which would hang the preview and
  exhaust memory.
- **`verify-viewers.mjs`**: asserts 12 CSV parsing cases (quoting, `""`
  escapes, newlines in fields, CRLF, ragged rows, truncation and column cap),
  page slicing (out-of-range page clamped, partial last page, an empty table
  still has 1 page), numeric column detection, valid / invalid JSON, and which
  views a file has and which one is the default. Tables and trees turn file
  content into UI; a parser bug does not throw, it silently shows wrong data.
- **`verify-git.mjs`**: two layers. (1) Fixed fixtures pin the **parsing** of
  git's three output formats: `status --porcelain=v1 -z` (a rename under `-z`
  is two records, "new path + bare original path"), `diff --numstat -z` (binary
  is `-\t-`, a rename leaves the path empty followed by two bare paths) and
  unified diff (hunk headers, line numbers on both sides, multiple hunks,
  binary notice); a parsing bug would silently show "modified" as "added". (2)
  A **real temporary repository** with a stub host driving the **real
  `main.js`** asserts `fm.list` badges (modified / added / staged / folder
  rollup / `null` for unchanged rows), the status returned by `fm.read`, the
  changed lines from `fm.git.diff` (replacement, all-added untracked file,
  staged section, deleted file), refusal of credential and out-of-root paths,
  immediate cache invalidation after saving, and **degradation to "no status"
  outside a repository while reads keep working**. Without git installed the
  second layer is skipped (the first still runs).
- **`verify-editors.mjs`**: three layers. (1) Parsing fixtures pin the text
  forms of editor detection: the `(Default)` value of registry `App Paths`,
  the `shell\open\command` of `StartMenuInternet` (quoted forms with arguments
  such as `"C:\…\chrome.exe" -- "%1"` must be stripped cleanly), the order of
  candidate file names on `PATH` (Windows accepts only `.exe`, first and only
  once), and exact match / prefix fallback for registry key names (Firefox
  subkeys carry a client hash suffix; `FIREFOX.EXE-308046b0af4a39cb` must
  match). (2) End to end: a stub host drives the **real `main.js`** and
  asserts the shape of `fm.editors`, the path and content of the on-disk cache,
  and the boundary that **the view never gets executable paths** (only id and
  display name); a **second real process** then reads the same cache and
  asserts an identical result without rewriting the cache file, which is what
  "probe once a day, shared across instances" must guarantee. (3) Path guards:
  unknown editor ids, root-escaping relative paths, credential files, the
  `external` form and missing arguments are all refused. A final case
  **actually launches once**: the "editor" is `node` itself and the opened item
  is a small script; the assertion is written by that real child process: the
  argument it received is exactly the absolute path of the opened file.
- **`verify-watch.mjs`**: three layers. (1) Pure noise and suppression rules:
  `.git/`, `node_modules/` at any depth, credential paths and this plugin's
  atomic-write temp files (`.README.md.<ts>.<rand>.tmp`) are not reported,
  while real files with the same names are; plus noting and checking "did I
  write this myself". (2) End to end: a temp directory and stub host drive the
  **real `main.js`** and assert that **the OS really delivers events**:
  external edits, creations and deletions appear in the cursor delta, asking
  the same cursor twice is idempotent, `.git/` and `node_modules/` changes are
  excluded, **the plugin's own saves are excluded**, a same-path change after
  the suppression window is reported again (watching does not quietly decay),
  the watcher follows folder switches, no project reports "unavailable"
  instead of throwing, and the watcher really stops after `onUnload`. (3) The
  view's decisions (pure functions in `lib/watch.ts`): changes elsewhere only
  refresh folders, an open changed file is re-read only without unsaved
  changes, unsaved changes only warn and never overwrite, the number of
  refreshed folders is capped, and a cursor outside the history is handled
  conservatively.
- **`verify-pdf.mjs`**: a stub host drives the real `main.js` and verifies
  case-insensitive `.PDF` detection, lossless base64 transfer, the 24 MiB
  boundary and over-limit handling, empty / corrupt files reaching the PDF
  viewer, and out-of-root paths, symlinks, credential limits and folder
  switching; it also checks stable widths for double-page cover / last page,
  mixed-size grouping, lazy / out-of-order loading and isolation between
  documents. PDF content routing and read-only behaviour are also covered by
  `verify-viewers.mjs`; rendering and interaction need a real browser.

PDF browser acceptance should use the production build and an offline
`file://` page: continuous scrolling of long documents with the bottom
reachable, page number sync, fit width for the three layouts with mixed
portrait/landscape pages, zoom unchanged and render events stopping after
scrolling and dragging back and forth across the single/double boundary at the
cover / last page, stable proportions after lazy loading new sizes, thumbnail
and nested / named outline jumps, the no-outline notice, page labels and Info /
XMP metadata, real mouse text selection, rotated pages and special page units,
CJK font mapping and scan / CMYK decoding, a 360px narrow panel, theme and
language, zoom after fast page changes, fast file switching, and recovery after
load / worker failures. After closing a PDF confirm the worker and Blob URLs
are released; once the browser-simulated host bridge passes, still check the
real panel interaction in a Desktop installer build.

Smoke test (run from the repository root):

```bash
node ../pi-file-manager-smoke-test.cjs
```

## Data and security

**This plugin reads and writes files in the current project with its own Node
`fs`, not through the host's `pi.fs` gateway.**

Why this is necessary: the host's `manifest.fs` syntax **forbids whole-tree
writes** (a write scope cannot be `**`), and any narrow scope that passes
validation would turn every save into a permission prompt; `pi.fs.*` also has
no create / rename / move, and `fs.glob` and `fs.list` have entry limits, skip
`node_modules` and hide credential paths. The trade-off: **the host permission
gateway does not mediate these calls**, so the plugin carries the security
responsibility itself. The manifest therefore declares no `fs.write` (write
access cannot be declared honestly), only `ui.view` and `fs.read`; **the latter
is used only for "open with default app" and "show in folder", which only the
host can perform** (`fs.openDefault` / `fs.reveal`, same permission and scope
as the built-in Files view: root `workspace`, scope `**`). The host checks
these two channels against the declared scope and refuses anything outside it.

Limits the plugin enforces itself:

| Limit | Description |
|---|---|
| Path containment | Relative paths are accepted only relative to the **currently selected registered folder root**; absolute paths, `..` and **symlinks / junctions** that resolve outside that root are refused. When a project registers several folders, the containment base is still **one** root, never the union of the group (switching the base only switches the door; the rules behind it stay the same); an absolute path the host asks to open under another root of the same project first switches the base to the containing root and is then resolved relative to it, with full containment checks. The only exception is an absolute path outside the project that the host asks to open (session scratch directory / attachments): allowed only when the view sets `external: true`, **without root containment** (it is outside the root by definition), with the deny list and realpath checks still fully enforced |
| Sensitive paths | `.env*`, `.ssh`, `.aws`, `.gnupg`, `.git/**`, `*.pem`, `*.key`, `*.p12` and similar are refused for read and write; `node_modules` is readable but not writable |
| Atomic writes | Write a temp file in the same folder, `fsync`, keep the original permission bits, then `rename` over the target; an interruption never leaves a half-written file |
| Conflict detection | `mtimeMs` + file size act as an optimistic lock; a file changed outside the editor is **never overwritten silently**: a dialog offers overwrite / discard / reload |
| Write audit | Every write appends a line to `write-audit.jsonl` in the plugin data directory (rotated at about 1 MiB), because the host cannot audit this path |
| Read-only databases | Opened with `readOnly` + `PRAGMA query_only = 1` (`DROP` / `INSERT` are refused by SQLite itself, tested), plus a statement allowlist: only `select` / `with` / `values` / `explain` and read-only `pragma`, and only a **single** statement, because `node:sqlite` prepare accepts multiple statements (tested: `select 1; select 2` runs only the first without error). Table and column names are checked against `sqlite_schema` before quoting, never interpolated directly |
| Size limits | Text preview 2 MiB, images 8 MiB, audio/video and PDF 24 MiB each, writes 8 MiB. Image, media and PDF bytes travel to the view as base64 (about 1/3 larger), hence separate limits; the message names the exact limit when exceeded |
| External editors | "Open with…" is spawned by the plugin main process: the executable **can only come from the list the plugin detected itself** (the view passes an id, never a path), and the target passes the same root containment check and credential deny list as every other channel; `spawn` uses no shell and a single absolute path argument; the child is `detached` + `stdio: ignore` + `unref`, so the editor outlives the panel without holding the plugin process; every launch is recorded in the write audit. On Windows only real `.exe` files are accepted (`.cmd` / `.bat` shims need `cmd.exe`, an unnecessary injection surface). Browsers are offered only for web files (pure function in `lib/editors.ts` filters by extension). Detection only reads the registry and `PATH`, writes nothing, and caches its result per day in `editors.json` in the plugin data directory |

Two behavioural notes:

- The `.git` directory **never appears in the tree** (huge and never useful).
- Ignore rules come from `.gitignore` and `.ignore` (supporting `!` negation,
  trailing `/`, leading `/` anchoring, `*` / `?` / `**`). This is a subset of
  gitignore without `\` escapes or `[a-z]` character classes; deviations only
  affect visibility and the eye button in the toolbar can always override them.

**Safe Markdown preview**: the preview **does not use**
`dangerouslySetInnerHTML`; Markdown is parsed into React elements, nodes are
escaped by React, and there is structurally no injection surface, so no extra
sanitizer is needed. The reason is simple: this view's bridge leads to a plugin
main process that can read and write project files, so an XSS in the preview
would equal arbitrary file writes. Links in the preview do not navigate either
(one click would leave the plugin page with no way back); a click only shows
the address.

**No network access**: no `net.domains`, no requests at runtime. The plugin
data directory only holds settings (split width, whether the left list is
collapsed, display toggles, default Markdown view, which folder each project
shows), the audit log above, and the daily editor detection cache
(`editors.json`, only the detected program paths, one per day).

## Known limitations

- **Deletion asks for confirmation first**: folders are removed recursively as
  a whole, with the same path limits as writes (inside the selected folder
  root, refusing the root itself and credential paths), recorded in the write
  audit; deletion cannot be undone.
- **"Open with default app" and "Show in folder" work for files only** (the
  host returns `INVALID_ARGUMENT` for folders); the entry is in the tree's
  context menu.
- **Images in the Markdown preview are still placeholders**: `![](path)` shows
  a placeholder with the file name. File-level image viewing via data URIs
  works, but preview images would need reading each relative path one by one,
  which is not done yet, again because the panel loads over `file://` and
  relative paths point at the view itself, not the project.
- **File watching**: the host has only one push channel to the view
  (`view:open`, for "open this file" requests) and no file change events, so
  external changes are not real-time; folders refresh after saving, and the
  toolbar's "Reload from disk" can pull in outside changes at any time (asking
  first when there are unsaved changes).
- **Paths outside the project only by host request**: only files the host asks
  to open may lie outside the project root (session scratch directory /
  attachments), and the view must declare `external` explicitly; the tree still
  shows only the current project, and the plugin never browses outside it on
  its own.
- **One folder root at a time**: when a project registers several folders, the
  tree, search, SQLite and all path checks resolve against the **currently
  selected root**; switch at the top left to view another folder (switching
  rebuilds the view state). The group's folders are never merged into one tree:
  there is always exactly one containment base.
- **Binaries are not previewed**: zip / apk / exe / tiff only show a notice; no
  unpacking, no archive listing, no hex view. TIFF in particular: Chromium
  cannot decode it, so it is treated as binary instead of showing a broken
  image.
- **Images, media and PDF are read-only**: view only, never in the editor
  (editing of other files is unaffected).
- **Large files are not previewed**: images over 8 MiB, audio/video or PDF over
  24 MiB only show the limit.
- **Password-protected and scanned PDFs**: a password-protected PDF suggests
  unlocking it in the default app; this version has no password input. Scans
  can be viewed but get no OCR and no invented selectable text; corrupt or
  unsupported PDFs report a clear error.
- **`.avi` and similar are treated as binary** (Chromium cannot play them);
  whether `.mkv` / `.mov` play depends on the codec inside, with a clear
  message when they cannot.
- **SQLite is read-only**: no writes, no VACUUM, no `-shm` creation. **Content
  in the WAL not yet checkpointed into the main file is not visible** (noted at
  the top); encrypted databases (SQLCipher) and corrupt files clearly report
  "cannot read" instead of an empty view.
- **Deep database paging is capped** (OFFSET ≤ 100,000 rows): `node:sqlite` is
  a synchronous API without an interrupt, so queries must be bounded by design;
  narrow further with conditions in the SQL box.
- **Row counts in the table list are estimates** (`max(rowid)`): an exact
  `COUNT(*)` is a full table scan on large tables; run it in the SQL box when
  needed.
- **Requires a host runtime with `node:sqlite`** (Node ≥ 22.5; the current host
  Electron 43 / Node 24 qualifies). If it is unavailable the plugin does not
  crash; it shows the overview and explains why.

## License

MIT. License notices for PDF.js and the bundled fonts and decoders are in the
build output `views/assets/pdfjs-LICENSES.txt`.
