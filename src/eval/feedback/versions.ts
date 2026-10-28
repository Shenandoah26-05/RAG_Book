/**
 * The version after `v1` is `v2`. Only plain numbered versions have a next one: `v1-smoke` is not
 * a step in a series, so promoting into "the next" of it would be a guess, and the caller must name
 * the new version.
 */
export function nextVersion(version: string): string | undefined {
  const match = /^v(\d+)$/.exec(version);
  return match?.[1] === undefined ? undefined : `v${(Number(match[1]) + 1).toString()}`;
}
