/**
 * Pure helpers for the web tools — kept dependency-free so they're unit
 * testable (SSRF address classification, filename inference, truncation).
 */

/**
 * Parse an IPv6 literal into its eight 16-bit groups, or null. Handles `::`
 * compression and an embedded dotted IPv4 tail (`::ffff:1.2.3.4`). Written
 * out rather than regex'd because the previous guard matched only the
 * DOTTED mapped form — and WHATWG/Node serialise `[::ffff:127.0.0.1]` as
 * `[::ffff:7f00:1]`, which sailed straight through to loopback (audit
 * 2026-09-05).
 */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s || /[^0-9a-f:.]/.test(s)) return null;
  // Embedded IPv4 tail → two hex groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = v4[1].split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, -v4[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > (halves.length === 2 ? 7 : 8)) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Private/internal address ranges `download_file` must never reach (SSRF). */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const g = parseIpv6(ip);
    if (!g) return true; // unparseable = treat as unsafe
    const isZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
    // :: and ::1
    if (isZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;
    // IPv4-mapped ::ffff:a.b.c.d (either spelling) and IPv4-compatible ::a.b.c.d
    const v4Tail = () => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    if (isZeroPrefix(5) && g[5] === 0xffff) return isPrivateIpv4(v4Tail());
    if (isZeroPrefix(6)) return isPrivateIpv4(v4Tail());
    // NAT64 64:ff9b::/96 — the embedded IPv4 is what gets reached
    if (g[0] === 0x64 && g[1] === 0xff9b && isZeroPrefix(6) === false && g.slice(2, 6).every((x) => x === 0)) {
      return isPrivateIpv4(v4Tail());
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 (deprecated site-local)
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // unparseable = treat as unsafe
  }
  return isPrivateIpv4(parts);
}

/** Hostnames that are private regardless of DNS. */
export function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal");
}

/** Pick a filename for a download: Content-Disposition, else URL path, else fallback. */
export function inferFilename(
  url: string,
  contentDisposition: string | null,
): string {
  if (contentDisposition) {
    // filename*=UTF-8''… takes precedence over filename="…"
    const star = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (star) {
      try {
        const name = decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
        if (name) return name;
      } catch {
        /* fall through */
      }
    }
    const plain = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain?.[1]?.trim()) return plain[1].trim();
  }
  try {
    const path = new URL(url).pathname;
    const base = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    if (base && base !== "/") return base;
  } catch {
    /* fall through */
  }
  return "download";
}

/** Truncate with an explicit marker so the model knows content was cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… truncated ${text.length - maxChars} characters]`;
}
