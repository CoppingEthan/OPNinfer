/**
 * Client-safe UUID generator. `crypto.randomUUID` only exists in a secure
 * context (HTTPS or localhost), so over a plain-HTTP LAN IP it's undefined and
 * throws. This falls back to `crypto.getRandomValues` (available in insecure
 * contexts) or `Math.random` so client-side id generation keeps working.
 */
export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rnd = (): number => {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const b = new Uint8Array(1);
      crypto.getRandomValues(b);
      return b[0] / 256;
    }
    return Math.random();
  };
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(rnd() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
