/**
 * Public GitHub repository that hosts Slyy release assets: installers, the
 * electron-updater `latest*.yml` feeds and the remote `pi-host` bundles.
 *
 * The source repository (`GITHUB_REPO` in `github-feedback.ts`) is private, so
 * users cannot download from it; `release.yml` publishes every release here
 * instead (ADR `slyy-downstream-branding`). electron-builder's `build.publish`
 * and `resources/app-update.yml` carry the same owner/repo as literals.
 */
export const GITHUB_RELEASES_REPO = "mySlyy/releases";

/** Releases page; GitHub redirects it to the list while only pre-releases exist. */
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_RELEASES_REPO}/releases/latest`;
