/**
 * A new random (version 4) UUID, which names one answer to the API so a rating of it can be replaced
 * by a later one. `crypto.randomUUID` exists only on pages served over HTTPS or from localhost; a page
 * opened by the address of the machine on a network falls back to building one from random bytes.
 */
export function newAnswerId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // the version (4) and the variant (10xx) are fixed by the format
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
