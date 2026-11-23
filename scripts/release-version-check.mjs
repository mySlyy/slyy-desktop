export function resolveReleaseDocumentCheck(currentVersion, requestedVersion) {
  const documentVersion = requestedVersion ?? currentVersion;
  const isPrereleasePreview =
    requestedVersion !== undefined &&
    currentVersion !== documentVersion &&
    currentVersion.startsWith(`${documentVersion}-`);

  return {
    documentVersion,
    surfaceVersion: isPrereleasePreview ? currentVersion : documentVersion,
    isPrereleasePreview,
  };
}

export function isModelsDevProviderCatalog(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).some(
        (provider) => provider && typeof provider === "object" && provider.models,
      ),
  );
}

/**
 * Workspace packages that ship on their own release train (own tag prefix,
 * own version) opt out of the desktop version lockstep with
 * `"releaseTrain": "independent"` in their package.json. scripts/release.mjs
 * does not bump them and check-release-docs.mjs does not compare them.
 * Today: apps/desktop-wireframes (tags desktop-wireframes-vX.Y.Z).
 */
export function isIndependentlyVersioned(pkg) {
  return Boolean(pkg && typeof pkg === "object" && pkg.releaseTrain === "independent");
}
