/** The engine that publishes the plain version tag. */
export const DEFAULT_ENGINE = "universal";

export function engineTagSuffix(proxyEngine: string): string {
  if (proxyEngine === DEFAULT_ENGINE || proxyEngine === "") return "";
  return `-${proxyEngine}`;
}

/**
 * Convert an action ref into the Docker image tag to resolve (e.g. `1.0.0`,
 * `1.0.0-inspect`, `sha-<sha>-inspect`).
 *
 * The suffix is not part of the Sigstore identity; engine-label.ts is what
 * binds the resolved image to the requested engine.
 */
export function imageTagFromRef(
  actionRef: string | undefined,
  proxyEngine: string = "universal",
): string {
  let base;
  if (!actionRef) {
    base = "";
  } else if (/^[0-9a-f]{40}$/i.test(actionRef)) {
    base = `sha-${actionRef.toLowerCase()}`;
  } else if (actionRef.startsWith("v")) {
    base = actionRef.slice(1);
  } else {
    base = actionRef;
  }

  return `${base}${engineTagSuffix(proxyEngine)}`;
}
