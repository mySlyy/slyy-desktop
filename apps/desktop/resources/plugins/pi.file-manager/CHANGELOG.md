# Changelog

## Unreleased

- Fix SSH workspaces remaining on Loading: remote directories and text/image
  previews now use the paired Host's scoped SDK reads, with explicit read-only
  controls, upgrade/errors and retry. Local file operations never receive an
  opaque remote project identity.
- Discard late previews, ancestor-directory opens and refresh loops after a
  workspace change. Restore local editor detection, Browser and watch
  capabilities when returning from a remote project.
- Show root and nested directory failures with their actual error and Retry
  action, rather than incorrectly showing Loading indefinitely.

- The "Open with…" menu of HTML, HTM and XHTML files gains "Open in built-in
  browser", shown only when the host provides the Browser API; it matches the
  host-declared `fs.read` file scope.
- Regrouped and reordered the tree context menu and added refresh to it; empty
  space shows only create and refresh, files and folders show type-specific
  actions.
- New **read-only PDF preview**: continuous vertical scrolling, "single /
  double / double with separate cover" layouts, previous / next page, page
  number input, 10%-400% manual zoom, fit width, 100% actual size, and text
  selection and copying when a text layer exists.
- New collapsible **navigation sidebar**: thumbnails rendered for the visible
  range with a current-page marker, an expandable nested outline / bookmarks
  (explicit and named destinations), file name / size / page count and PDF
  Info / XMP metadata; a missing outline is stated explicitly, and PDF page
  labels are shown with physical page numbers. On narrow panels the sidebar
  overlays, closes after a jump and closes with Escape; the UI follows the
  language and light/dark theme.
- The PDF.js compatibility build, worker, CMaps, standard fonts, WASM decoders
  and ICC colour resources are all bundled for the offline `file://` view; the
  build emits third-party license notices. PDF has its own **24 MiB** limit;
  password-protected, corrupt, empty and oversized files show clear messages.
- Fit width is computed from the actual size of the widest known page group in
  the current layout, handling mixed portrait/landscape, rotation and special
  page units; scrolling keeps proportions, and a separate cover or a lone last
  page no longer triggers repeated zooming and rendering. Panel or sidebar size
  changes refit, using only sizes of pages already initialised, compatible with
  lazy loading.
- PDF.js manages rendering and caching of nearby pages in the main view;
  thumbnails reuse its cleanup events to release page resources outside the
  main cache; canvas pixels are capped, and switching files, load failures or
  leaving the viewer clean up the document, listeners, worker and Blob URLs.
  Returning to a cached page syncs its loading state, and zoom after fast page
  changes keeps the latest reading position.
- New `verify:pdf`, included in `verify`, covering binary transfer, size
  boundaries, path limits, folder switching, stable page group widths, mixed
  sizes and lazy / out-of-order loading; viewer routing checks add the
  read-only PDF type. Browser acceptance covers navigation and content display,
  scrolling and dragging stability across boundaries, error recovery and
  resource release.
- PDF full-text search reuses the matching `PDFFindController`, with match
  highlighting for Latin and CJK text, counts, previous/next match, Enter /
  Shift+Enter and Ctrl/Cmd+F inside the reader; clearing, closing, reloading or
  switching documents resets the search. IME composition keys keep candidate
  handling, plain input keeps PDF.js debouncing.
- The PDF find button uses an SVG magnifier with an explicit icon size that
  scales with the toolbar font size; narrow-panel wrapping and accessible
  labels are kept, so the glyph is neither too small nor dependent on system
  fonts.
- PDF full-text search adds combinable match case, whole word and regular
  expression toggles; an invalid or unsupported expression clears highlights
  with an accessible message and recovers once fixed.
- The three PDF search toggles use in-UI hover and keyboard focus tooltips,
  also shown when the search box is empty or cleared; the descriptions no
  longer depend on the host's native title tooltip.
- Regex matching moves into a separate offline worker, run page by page;
  a page timeout (1 second) or more than 100,000 matches stops with a notice;
  clearing, closing, switching mode or document cancels the old task, discards
  stale results, and idle workers are released automatically.
- Fix teardown on PDF worker failure or hang: after a bounded wait, clean up
  the document's fonts, filters, page tasks and message listeners, then close
  the port and revoke the Blob URL; startup and render cancellation waits are
  bounded too.
- Fix accumulating text-layer listeners on repeated outline navigation: one
  navigation listener per document; a completed target is focused directly,
  and a new jump or teardown cancels the old target.
- Fix horizontal text-layer metrics for PDFs with embedded fonts: prefer the
  embedded fonts PDF.js has loaded and keep separate geometry items for
  word spaces; selections in ordinary body text align better with the canvas,
  Type3 / missing fonts still use the fallback.
- A failed load of a valid later page enters the existing error and resource
  release flow; the open-file watch check uses the current path, restoring
  automatic re-reading for PDF / plain text, and with unsaved text only a
  notice appears and edits are kept.
- New isolated Electron desktop regression checks using a temporary project
  and profile, synthetic PDFs and the production `file://` view, covering
  search, watching, corrupt pages and worker failure recovery.

## 0.9.0

- **Three new context menu items**: **Copy relative path**, **Copy absolute
  path**, and the **"Open with…"** submenu, which expands on hover, lists the
  programs actually installed on this machine and opens the current entry
  (file or folder) in the chosen one.
- **Filtered by file type**: editors open anything; **browsers appear only for
  web files they can actually render** (`.html` / `.htm` / `.shtml` / `.xhtml`
  / `.mhtml` / `.svg` / `.pdf` / `.xml`). Opening `App.tsx` in Chrome only
  shows a plain-text page, which is noise, so it is not listed; the same goes
  for folders (a browser only shows a directory listing). The rule is a pure
  function in `lib/editors.ts`: the main process only labels what a program is
  (`kind`: editor / browser; only it knows Chrome is a browser), and the view
  filters by the right-clicked file; each side owns half, so adding a browser
  needs one change.
- **Editor detection never walks directories.** Four sources, each
  O(candidates): registry App Paths (HKLM / WOW6432Node / HKCU; installers
  almost always leave a `<name>.exe` → absolute path entry there), registry
  StartMenuInternet `shell\open\command` (browsers such as Chrome / Edge /
  Firefox / Zen register only there), executables on PATH by candidate command
  name, and one `stat` each for a few fixed install locations derived from the
  user's home directory. "Walk the disk to find software" is the easiest wrong
  version of this feature, and also the slowest.
- **Probe once a day, shared across instances.** Results are cached by **date**
  (local time zone) in `editors.json` in the plugin data directory: a second
  window or second launch on the same machine and day reads that cache instead
  of querying the registry again. A failed write falls back to the in-process
  cache; concurrent calls share one probe. The registry queries run in
  parallel: about 600ms cold, 0ms afterwards.
- **Honest when nothing is found.** With no editor detected, the submenu keeps
  only "System default app", never an entry that does nothing; if detection is
  unavailable there is just one menu level fewer.
- **Executables never leave the main process.** The view only gets an `id` and
  a display name and can only pass back an `id`; the main process looks up the
  editor path in its own detection results, so the view cannot choose what
  runs. The opened path first passes the same root containment check and
  credential deny list as every other channel (`.env*` / `.ssh/` / `*.pem` /
  `.git/**` are still refused); `spawn` uses no shell and a single absolute
  path argument; the child is `detached` + `stdio: ignore` + `unref`, so the
  editor survives the panel closing and never holds the plugin process; every
  launch is recorded in the write audit.
- **Only real `.exe` files (Windows).** `.cmd` / `.bat` shims run through
  `cmd.exe`, and splicing user project paths into a command line is an
  unnecessary injection surface; editors in App Paths and on PATH almost always
  provide a real `.exe`, so this limit does not miss them.
- **The submenu is a first-class interaction**: hover expands, `→` enters, `←`
  goes back one level, `↑↓` / `Home` / `End` move within a level, `Escape`
  closes everything; when it would overflow the viewport it flips to the left
  of its trigger instead of going off screen.
- New offline check `pnpm verify:editors` (text parsing fixtures for registry /
  command line / PATH candidate names + end-to-end with the real `main.js` +
  a "once a day" assertion with a second process reading the same cache + the
  boundary that the view never gets executable paths + **actually launching an
  editor process once** + the applicability pure function + a wiring assertion
  that `kind` reaches the view and the view uses that filter).

## 0.8.2

- **Fix own saves (`Ctrl+S`) still being treated as external changes**: 0.8.0
  already noted "I wrote this file myself", but the recursive watcher on
  Windows additionally reports `change <dir>` once for **every ancestor
  directory** of a written file (tested: writing `src/deep/x.ts` reports
  `change src/deep` and `change src`; the file name is not lost, the name is
  just a directory). Those events were not in the suppression table, so any
  `Ctrl+S` could be judged an external change and the just-saved document was
  reloaded, losing cursor and scroll position, exactly what 0.8.0 meant to
  prevent.
  `noteSelfWrite` now records every ancestor directory along with the file
  path (the root itself emits no such directory event, so recording stops at
  the outermost directory); `pnpm verify:watch` adds this regression (unit
  layer + nested-path end to end): **both assertions failed reliably before the
  fix and passed 6 runs in a row after it**.
- **Also fix a timing race in `verify:watch`**: late directory events from the
  previous step (external create / delete) could land in the current save
  window and occasionally fail the assertion (1 in 5 runs). Before taking the
  cursor it now waits until two consecutive rounds show no new change, so the
  assertion reflects only the operation it tests.
- On non-Windows platforms this change is a no-op (they emit no ancestor
  directory events); behaviour is identical to 0.8.1.

## 0.8.1

- **Fix preview and diff overlapping when opening changes in preview mode**:
  two structural issues combined: (1) "Changes" was a separate toggle
  **outside** the tablist (`aria-pressed`), not exclusive with "Edit /
  Preview", so "preview on + changes on" was a valid combination; (2) the
  content area rendered each view by its own boolean, so the Markdown preview
  and the diff, both full height, could mount together and overlap.
- **Now one decision point** (`views-src/src/lib/pane.ts`): `contentKind()`
  gives the **single** view the content area renders (changes over preview >
  byte kinds), and `tabs()` / `activeTabKey()` give the mutually exclusive tab
  group in the header. `EditorPane` renders only that single value: two full
  views at once is not prevented by remembering a render condition, there is
  structurally no second true.
- **"Changes" is now the third tab in the tablist** (Edit / Preview / Changes
  in one group): reachable from either side; clicking "Edit" or "Preview"
  closes changes and returns to the previous view; `activeTabKey()` keeps the
  selection unique.
- Two more fixes: the Changes tab is offered only for **text files** (images /
  media / databases own the content area, and a line diff means nothing for
  them); `tabs()` de-duplicates modes itself, since duplicate keys make React
  reuse the wrong node, which only shows when a mode happens to repeat.
- **Regression pinned in `verify-viewers.mjs`**: an exhaustive input scan
  asserts the content view is always single-valued, all ten views are
  reachable, "changes beat preview / preview returns after closing changes",
  and the tab group has one selected item.

## 0.8.0

- **File watching (auto-refresh)**: files changed outside this view (another
  editor, `git checkout`, build output, another window) are detected within
  about a second and **re-read**, and tree and list refresh (size, mtime, git
  badges, created and deleted entries) without pressing "Refresh". The main
  process opens one recursive `fs.watch` on the **current base root**
  (`persistent: false`); changes are debounced for 250ms into a bounded cursor
  history (400 entries), and the view fetches the delta every 1.2 seconds (the
  host gives plugins no push channel to a view, so the view polls); the round
  is skipped while the panel is hidden.
- **Three rules**: (1) an open file is re-read automatically **only without
  unsaved changes; with unsaved changes only a notice bar appears and nothing
  is overwritten**, and the bar's "Reload" still uses the existing
  unsaved-changes confirmation; (2) the plugin's own saves (temp file + rename)
  are noted first, and a same-path event within 1.5 seconds is not an external
  change, otherwise every `Ctrl+S` would reload your own document and lose
  cursor and scroll position; (3) one external change refreshes at most 8
  folders, the rest is left for the next round or a manual refresh, so the
  panel is not flooded.
- **Noise and lifecycle**: `.git/`, `node_modules/` at any depth, credential
  paths (`.env*` / `.ssh` / `*.pem`…) and the plugin's atomic-write temp files
  are never reported; the watcher follows base switches and closes when the
  plugin unloads; if the runtime cannot watch recursively, only auto-refresh is
  off and manual refresh and everything else are unaffected.
- **UI**: a new "Auto-refresh" switch at the top (can be turned off; disabled
  with an explanation when watching is unavailable, never a dead control), and
  a notice bar for external changes while there are unsaved edits; **both
  manual refresh buttons stay**: watching only saves a click.
- **New offline check `pnpm verify:watch`** (part of `pnpm verify`): noise
  filtering and own-write suppression, end to end with a real `fs.watch`
  (edit / create / delete, idempotence, suppression window, base switch, no
  project, `onUnload`), and the view's "re-read or notify" pure function.

## 0.7.0

- **Git status in the file list**: each row gets a badge following git's own
  model: green `A` added (including untracked new files), amber `M` modified,
  red `D` deleted, blue `R` renamed, purple `U` conflicted; the end of the row
  shows `+N` / `−N` against the last commit; **folders show a rollup of their
  whole subtree** (most notable status + number of affected files), so a dirty
  folder is visible without expanding. Hover adds "staged or not / untracked or
  not", and the top of the left list summarises the current branch and the
  file count per change kind.
- **Line-by-line changes**: for a changed file the toolbar shows a "Changes"
  button ("View changes" in the context menu) that opens a line-by-line unified
  diff: additions green, deletions red, line numbers on both sides, hunk
  headers keep the enclosing function name; **staged (HEAD → index) and
  unstaged (index → disk) sections are labelled separately**, untracked new
  files show as all-added, and deleted files still show what was removed. The
  diff view has its own refresh and "Back to file", and badges and diffs update
  immediately after saving.
- **Status and diffs come from the real git in the working copy**: read-only
  subcommands `status` / `diff` / `rev-parse`, no index writes, no network,
  nothing inside `.git/**` (`GIT_OPTIONAL_LOCKS=0` / `GIT_TERMINAL_PROMPT=0` /
  `GIT_LITERAL_PATHSPECS=1`); each subcommand has a 5s timeout and an output
  cap, results are cached for 2s and invalidated immediately after the plugin's
  own saves. The plugin parses the `porcelain` / `numstat` / `unified diff`
  output forms itself.
- **Complete degradation**: without git, outside a repository, or when git
  times out or is missing, all marks and entries disappear, and listing /
  reading / writing / saving / deleting behave exactly as in 0.6.0; path limits
  and the credential deny list are not relaxed (`fm.git.diff` also passes the
  root containment check first).
- **New offline check `pnpm verify:git`** (part of `pnpm verify`): pure
  function fixtures pin git's three output formats, plus end to end with a
  real temporary repository (`fm.list` badges / `fm.read` status /
  `fm.git.diff` changed lines / out-of-root and credential refusal / immediate
  update after save / degradation outside a repository). The end-to-end layer
  is skipped when git is not installed.

## 0.6.1

- **Fix the Markdown preview being too narrow and not following the sidebar
  divider**: the preview body was pinned to a fixed column of about 78
  characters by a leftover `max-width: 78ch` on `.md-body` and did not move
  when dragging the split divider; it is now `max-width: 100%`, so the preview
  fills the editor area and follows the split width live (tested in a headless
  browser: preview container 1081px full width, correct layout after dragging).

## 0.5.2

- **Fix the list not following a folder switch**: the host reports
  directories with forward slashes (`C:/Users/…`), while the plugin stored its
  memory via Node's `path.resolve()` with backslashes (`C:\Users\…`); the
  comparison only tried "as is" and "case-insensitive", without normalising
  separators, so the memory matched no root and the containment base fell back
  to the primary folder. The view still matched with its own raw string, so
  the header name changed while list and editor stayed on the primary folder,
  and the choice was not remembered across reopening. Path comparison is now
  separator-independent (`samePath` / `matchRoot`, changed in both `main.js`
  and `lib/roots.ts`), and **already corrupted memory entries are recovered**
  without the user switching again.
- Tests cover the path: `verify-roots.mjs` asserts the same directory with
  different separators matches; the `verify-jail.mjs` stub host now uses
  **forward slashes** (like the real host) and asserts that after switching the
  sibling folder's own files are listed; this section failed before the fix.

## 0.5.1

- **Fix "Open with default app" / "Show in folder" opening the wrong file
  after switching folders**: these two channels are executed by the host and
  only accept workspace-relative paths, so with the base switched to a sibling
  folder in the project group the host resolved the relative path against the
  **primary folder**, opening the other file when both folders had the same
  name (a 0.5.0 defect). With a non-primary base an absolute path is now sent,
  and the host has a matching narrow allowance for absolute paths under the
  project's registered folder roots (ADR 0253); with the primary base the
  behaviour is identical to 0.5.0 / 0.4.
- **Switching folders also clears the editor**: tree, expansion, selection,
  search and open files are reset, and the editor buffer is cleared as files
  close (the empty panel no longer keeps the previous folder's document);
  unsaved changes are still confirmed before switching.

## 0.5.0

- **Multi-folder project groups**: the host can register one project as
  several local folders (`workspace.get()` and the initial handshake carry
  `roots` / `projectId`). The folder name at the top left of the panel becomes
  a switcher: with more than one folder it opens the group's folder menu
  (primary folder marked, current one checked), keyboard accessible with
  `aria-haspopup` / `aria-expanded`, closed by Escape or a click outside; with
  a single folder (or an older host sending no group info) the header is
  identical to 0.4.0, with no dead entry.
- **The browsed folder is remembered per project**: key `p:<projectId>`
  (`r:<primary root path>` when the host gives no projectId); a value is
  trusted only if it matches a current root, otherwise the primary root is
  used; at most 20 entries, evicted by most recent write; new projects start at
  the primary folder.
- **The containment base is always a single root**: tree / read / write /
  create / rename / move / search / SQLite all resolve against the selected
  root; `..`, symlink and junction escapes and the credential deny list are not
  relaxed; an absolute path under another root of the same project switches the
  base first and is then resolved relative to that root.
- **Switching rebuilds the view state** (tree, expansion, selection, search,
  open files) and still asks for confirmation on unsaved changes first;
  cancelling changes nothing.

## 0.4.0

- **Host-driven open requests**: both the `?piViewOpen=` payload of the entry
  URL and the `view:open` push are handled (read once synchronously at mount,
  used for live updates after load; before load completes the host rewrites
  the URL and reloads), and a duplicate delivery is processed once.
  Project-relative paths still expand and load their ancestors, and the dirty
  buffer guard still applies.
- **Absolute paths outside the project can be opened and saved**: session
  scratch / attachment paths chosen by the host carry an `external` flag; the
  plugin skips root containment for them (they are outside the root by
  definition), while the credential deny list stays fully enforced on the raw,
  normalised and realpath forms.
- **The left file list can be collapsed as a whole**: it collapses
  automatically (and persists) on host open requests, keeps the split width
  and restores it on expanding; the toolbar gains a keyboard-accessible toggle.

## 0.3.1

- **"Open with default app" and "Show in folder"**: from a file's context menu
  (via the host's `fs.openDefault` / `fs.reveal`). Only the host can perform
  these actions, so the manifest declares `fs.read` for the first time (root
  `workspace`, scope `**`), identical to the built-in Files view; the plugin's
  own reads and writes still use Node fs in its own process, not mediated by
  the gateway. Folders are invalid for these actions (the host returns
  `INVALID_ARGUMENT`), so they are offered for files only.

## 0.3.0

**From "edit text only" to "see all kinds of files"**: images, audio/video,
delimited text and JSON each get their own viewer; the remaining binaries (zip
/ apk / exe) clearly say "preview not supported" instead of a vague "probably
binary".

- **Image viewing**: png / jpg / jpeg / gif / webp / avif / bmp / ico / svg.
  Fit to window by default, switchable to "actual size" (scrolls when larger),
  pixel dimensions and size at the bottom, checkerboard stage so transparency
  is visible. Bytes are read by the main process into a **data URI** sent with
  the response: the panel is a `file://` sandbox page without filesystem
  access, and relative paths only point back at the view itself, which was the
  root cause of "image detected but not shown" before.
- **Audio and video**: mp4 / m4v / mov / webm / ogv / mkv use `<video>`, mp3 /
  m4a / aac / wav / flac / ogg / opus / weba use `<audio>`. No autoplay (the
  panel may switch to a media file without the user noticing, and making sound
  would overstep); an unsupported codec or container shows a clear message
  instead of a black box.
- **Table view for delimited text**: `.csv` / `.tsv` open as a table, first row
  as a sticky header, whole-row hover. The hand-written parser supports
  quoting, `""` escapes, newlines in fields, CRLF and ragged rows; capped at
  1000 rows and 60 columns, with a note below the table when exceeded.
- **JSON tree**: `.json` / `.jsonc` / `.json5` can switch to a tree view.
  Expanded two levels by default, at most 100 keys rendered directly per node,
  overlong strings truncated (full value in the title). A parse failure is a
  result, not a crash: non-strict JSON such as `//` comments or trailing commas
  shows "parse failed + reason", and the source view stays editable.
- **Binaries are labelled**: files without a previewable form, such as zip /
  apk / exe, now show "Binary file (zip, apk, exe, etc.), preview not
  supported", with the exact numbers when a type exceeds its limit.
- **Tiered size limits**: text 2 MiB, images 8 MiB, audio/video 24 MiB (the
  latter two travel as base64, about 1/3 larger, hence separate limits). The
  message names the exact limit when exceeded.

### SQLite: read-only browsing + structure + custom SQL queries

- **New preview type `kind: "sqlite"`**: `.db` / `.sqlite` / `.sqlite3` /
  `.db3`, detected by extension plus the `SQLite format 3\0` file header
  (Windows `thumbs.db` is actually an OLE file, so the extension alone would
  misjudge it; a wrong magic number falls back to an ordinary file). fm.read
  reads only the 100-byte header to return the overview, **so there is no size
  limit**: this is the only preview type in the plugin that can open large
  files (databases of hundreds of MB).
- **Bytes never reach the view**: the database is queried in the main process
  through three new channels `fm.sqlite.open` / `.rows` / `.query`, sending one
  page of rows at a time. Paging and sorting are therefore pushed down to SQL.
- **Browse**: table/view list (`sqlite_schema`), paged rows (page size reuses
  the table preference), sortable headers, a leftmost `rowid` column (views and
  WITHOUT ROWID tables fall back to plain fetching), `NULL` greyed out, BLOBs
  shown by size only, column types and PK/NOT NULL in the header tooltip.
- **Structure panel**: columns and types, indexes, triggers, and the original
  `CREATE` text (all in the schema anyway).
- **Read-only SQL query box**: `Ctrl/Cmd+Enter` runs, optional row limit
  (100-5000), shows duration and truncation; the result grid reuses the same
  table (local paging + local sorting, since results are already capped).
- **Read-only in three layers**: opened with `readOnly: true` → `PRAGMA
  query_only = 1` (tested: SQLite refuses `DROP`/`INSERT`) → statement
  allowlist (only `select`/`with`/`values`/`explain` and read-only `pragma`,
  and **single** statements enforced: `node:sqlite` prepare accepts multiple
  statements; tested, `select 1; select 2` runs only the first without error).
  Table and column names are checked against the schema before quoting, and
  sort direction accepts only `asc`/`desc`.
- **Performance and limits**: handle LRU (at most 2, closed after 60 seconds
  idle, reopened automatically after an external change), at most 5000 rows
  per fetch, cells truncated at 4 KB, OFFSET ≤ 100,000 rows (the synchronous API
  has no interrupt, so queries must be bounded by design), row counts estimated
  with `max(rowid)` instead of an exact `COUNT(*)`.
- **Graceful degradation**: `node:sqlite` is probed at runtime; without it only
  the overview shows with an explanation, and the plugin never crashes.

### CSV / TSV: paging + sorting + layout rework

- **Paging replaces truncation.** Previously only the first 1000 rows were
  shown, so row 1001 and later were never visible. The whole file is now parsed
  once and rendered per page, **1000 rows per page** by default; the bottom bar
  shows "current range / total rows", "page x of y" and the first five page
  buttons, and the page size can be changed (100 / 200 / 500 / 1000 / 2000 /
  5000, remembered). Paging also caps cost: however large the file, only one
  page of cells is laid out.
- **Click a header to sort**: the whole cell is a button; one click ascending,
  two descending, **three back to file order** (the row number column shows the
  original order, so "unsorted" is a meaningful state, not just a reset).
  Sorting reorders data rows only, the header stays, and paging returns to page
  1.
  - All-numeric column → numeric comparison: `10` after `2`, `-10` before
    `-5`, `9.25` before `9.5`.
  - Otherwise natural text order: `file2` before `file10`, case-insensitive.
  - **Empty values always sink to the bottom**, ascending or descending
    (otherwise descending would float all empty rows to the top).
  - Numeric sorting and right alignment share the same "whole column is
    numeric" criterion, so a right-aligned column never sorts as text.
  - Sort keys are computed once before sorting (O(n) + sort) and a single
    `Intl.Collator` instance is reused: the comparator runs hundreds of
    thousands of times, and a new collator per call would freeze large files.
- **Layout is now "scroll area + bar pinned at the bottom".** The row count
  note used to follow the table and was visible only at the very bottom; the
  bar is now fixed, with paging, range and page size always available.
- **Leftmost row number column** (sticky left): you always know your row while
  scrolling horizontally or paging; numbers continue across pages.
- **Sticky header and sticky row numbers together**: wide tables stay anchored
  in both directions. Sticky cells have an opaque background, so nothing shows
  through.
- **Zebra stripes + whole-row hover**: scanning a row never drifts into the
  next.
- **Numeric columns are right-aligned automatically**: only when the whole
  column (current page, empty values allowed) is numeric, so decimal points
  line up and magnitudes are obvious; one non-number falls back to left
  alignment.
- **Cells get a `title`**: ellipsis-truncated values show in full on hover.
- The column limit stays at 60, noted in the bar when exceeded; the parse limit
  is now 200,000 rows (the file is already limited to 2 MiB; this is only a
  memory safeguard).

### Save path: issues fixed after an in-depth review

- **Editor content reverted to an old version after saving (severe).** On a
  successful save `openFile` must become a new object, carrying the new
  `mtime` / `size` as the next optimistic lock expectation, but the
  `EditorPane` effect depended on `[file]` and re-ran `setDocument(file.text,
  …)`, replacing the whole document with **the old text from when it was
  opened**: cursor reset, scroll back to the top, while the UI showed "Saved".
  Worse, pressing `Ctrl+S` again right after (saving had no dirty check) wrote
  that old text back to disk, really losing changes.
  Loading from disk now carries its own `loadToken`: switching file / reloading
  → new token; saving → same token, and the editor skips reloading.
- **Writing without changes**: a habitual `Ctrl+S` bumped the `mtime` and
  wrote an audit line, and if the file had been changed elsewhere a conflict
  dialog appeared out of nowhere. Without changes it now returns immediately
  ("Overwrite" in the conflict dialog is explicit intent and still writes).
- **Pressing `Ctrl+S` twice caused a self-conflict**: the second save used the
  same `mtime` expectation. Repeated requests for the same file now reuse the
  save in flight instead of issuing a second write.
- **The user may have switched away when a save returns**: metadata, dirty
  flag and conflict dialog landed on the newly opened file, making the next
  save report a false conflict. Results now apply only if the target is still
  the current file.
- **`Ctrl+S` only worked with editor focus**: after clicking a toolbar button,
  or on the preview / table / tree, it did nothing. It is now also handled at
  window level (the editor's own handling is unchanged; events already
  `preventDefault`ed are skipped, so nothing saves twice).
- **"Reload from disk" was disabled on clean files**: so external changes could
  not be pulled in. It is now always available (still confirming first when
  there are unsaved changes).

### Two real issues fixed along the way

- **Long Markdown previews were clipped and could not scroll**: `.md-scroll`
  was an in-flow child block (`height:auto`) inside a fixed-height parent with
  `overflow:hidden`, so content beyond one screen was clipped and
  `overflow:auto` never showed a scrollbar because the height was
  unconstrained. All four viewers are now absolutely positioned to fill the
  content area.
- **The preview rendered the text from when the file was opened**: editing and
  then switching to preview showed the old version from disk. It now reads the
  editor's current text (falling back to the file content while the editor has
  not loaded a just-switched file, so files never mix).

### Verification

- New **`pnpm verify:viewers`** (part of `pnpm verify`): 12 CSV parsing cases,
  valid / invalid JSON, which views a file has and which is the default, and
  the invariant that **saving must not change `loadToken`** (breaking it brings
  back the "content reverts after saving" bug above), all asserted offline.
- Smoke test adds `[4b]`: a second save right after, using the `mtimeMs` /
  `size` returned by the first (exactly what the view does; any mismatch gives
  the user a false conflict), `size` matching disk after CRLF conversion, and
  saving after an external delete recreating the file.

## 0.2.0

- **Fix missing syntax highlighting**: the root cause was that `codemirror`'s
  `basicSetup` registers
  `syntaxHighlighting(defaultHighlightStyle, { fallback: true })` internally,
  creating two fallback highlighters alongside the plugin's own style, with
  undefined precedence. The extension list is now assembled explicitly, with a
  single highlighter.
- **Language resolution via an explicit registry**: no more heuristic matching
  from `@codemirror/language-data` (it matched `.ts` to the wrong language and
  bundled many unused languages such as Angular/Jinja/Liquid/Wast). Extensions
  and file names now map exactly, the bundle shrinks from 1.87 MB to 1.30 MB,
  and C#, Kotlin, Scala, Dart and Objective-C are added.
- **New `pnpm verify`**: two offline verification scripts covering two paths
  that fail silently: syntax highlighting (the full parse → highlight token
  chain) and Markdown preview (asserting the real element tree, the link
  allowlist and the absence of `dangerouslySetInnerHTML`).
- **Selected and hover states in the file list are distinct**: hover is a faint
  neutral tint; selection is an accent background + accent bar on the left +
  foreground text + medium weight, kept when the mouse leaves and one step
  darker on hover.
- **New context menu**: right-click a file or folder to create a file, create
  a folder, rename, move, open or refresh; right-click empty list space for
  "New here" and refresh. Supports ↑↓ / Home / End / Enter / Esc.
- **New Markdown preview / edit toggle**: `.md` / `.markdown` / `.mdx` show a
  toggle in the toolbar; the choice is remembered. The preview supports
  headings, fenced code blocks (reusing the editor's highlighting), quotes,
  rules, ordered / unordered / task lists (nested by indentation), tables
  (with alignment), inline code / bold / italic / strikethrough / links /
  images. It renders React elements instead of `innerHTML`, so there is
  structurally no injection surface; links do not navigate.

### Two real issues fixed during development

- Markdown inline parsing shared one `g`-flagged regex across recursive
  handling of nested emphasis; inner calls clobbered the outer `lastIndex`,
  hanging the preview and exhausting memory. Each call now creates a new
  regex.
- A context menu effect depended on an array recreated on every render, which
  kept pulling focus back to the first item during arrow-key navigation. It
  now reads the latest value through a ref and sets the effect up only on
  mount.

## 0.1.0

First release.

- **Right work panel view** (`contributes.views` + `ui.view`): full directory
  tree, split layout, editable and savable content.
- **Directory tree**: lazy loading, folders first, keyboard navigation (↑↓
  Home End ←→ Enter); row icons follow the file type, covering code, config,
  styles, markup, data, scripts, images, archives, fonts, lock files and other
  common types, with special handling for names such as `package.json` /
  `Dockerfile` / `LICENSE`.
- **Editor**: CodeMirror 6 with line numbers, find/replace, multiple cursors,
  bracket matching and code folding.
- **File operations**: new file, new folder, rename, move.
- **Filename search**: paged project-wide search; results jump to and reveal
  the file.
- **Ignore rules**: entries hidden by `.gitignore` / `.ignore`, with a
  one-click toggle to show them; without rule files every entry is shown.
- **Safety rails**: path containment (refusing `..` and symlink/junction
  escapes), sensitive path deny list, atomic writes (temp file + fsync +
  rename), conflict detection with an `mtimeMs` + size optimistic lock, a
  write audit log, and preview and write size limits.
- **Follows the host appearance**: light/dark and UI language follow the
  Desktop shell.
