export interface BrowserRandomSource {
  randomUUID?: () => string;
  getRandomValues: (bytes: Uint8Array) => Uint8Array;
}

/** Create a private per-tab ID using the strongest browser CSPRNG API available. */
export function createViewerId(source: BrowserRandomSource): string {
  if (typeof source.randomUUID === "function") return `v_${source.randomUUID()}`;

  const bytes = source.getRandomValues(new Uint8Array(16));
  // RFC 9562 UUIDv4 version and variant bits. Older Web Crypto implementations expose
  // getRandomValues but not randomUUID, so format those secure random bytes ourselves.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
