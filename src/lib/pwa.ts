/**
 * Installable-app (PWA) metadata — the pure half.
 *
 * The web manifest is built from THIS instance's own identity, not from a file
 * committed to the repo, because one image serves four differently-branded
 * portals. A static `public/manifest.json` would put "OPNinfer" on a client's
 * home screen next to their own apps — the same leak the CHANGELOG rules exist
 * to prevent, except this one sits on the phone permanently. The database read
 * lives in the route; this file only decides the shape, so it can be tested
 * without a server.
 *
 * Deliberately small: a manifest, icons rendered from whatever logo the admin
 * uploaded, and nothing else. There is no offline chat here and there should
 * not be — the app is a client for a server it cannot work without.
 */

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: "any" | "maskable";
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/**
 * The icon sizes the manifest advertises. 192 and 512 are what Chrome requires
 * for installability; 512 also feeds the Android splash screen.
 */
export const MANIFEST_ICON_SIZES = [192, 512] as const;

/** iOS reads this one from a <link>, never from the manifest, and wants 180. */
export const APPLE_TOUCH_ICON_SIZE = 180;

/** Every size the icon route will render. Anything else is refused, so the
 *  route can never be turned into an arbitrary image resizer. */
export const ALLOWED_ICON_SIZES: readonly number[] = [
  APPLE_TOUCH_ICON_SIZE,
  ...MANIFEST_ICON_SIZES,
];

/** Light-theme surface, matching `--background` in globals.css. The manifest
 *  carries one value while the page carries a light/dark pair, so the splash
 *  uses the light one and the per-page <meta name="theme-color"> (which every
 *  platform prefers when present) still follows the device. */
export const PWA_BACKGROUND = "#ffffff";

export const PWA_ICON_PATH = "/api/pwa/icon";

/**
 * A home-screen label. Android truncates at roughly a dozen characters and iOS
 * is no kinder, so "Acme AI Assistant" would read as "Acme AI Assi…" under the
 * icon. Drop whole words from the end until it fits — "Acme AI" is a better
 * label than an ellipsis, and the full name still rides in `name` for the
 * install prompt and the app switcher.
 */
export function shortAppName(name: string, limit = 12): string {
  const full = name.trim().replace(/\s+/g, " ");
  if (full.length <= limit) return full;

  const words = full.split(" ");
  let out = "";
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > limit) break;
    out = next;
  }
  // A single word longer than the limit has nothing to drop; cut it.
  return out || full.slice(0, limit);
}

/** URL for one rendered icon. `v` busts the cache when the admin changes the
 *  logo — without it a re-uploaded mark would sit on installed home screens
 *  until the icon's day-long cache expired. */
export function iconUrl(
  size: number,
  opts: { maskable?: boolean; v?: string } = {},
): string {
  const params = new URLSearchParams({ size: String(size) });
  if (opts.maskable) params.set("maskable", "1");
  if (opts.v) params.set("v", opts.v);
  return `${PWA_ICON_PATH}?${params.toString()}`;
}

/**
 * A cache token for the icons. The branding logo is stored under a filename
 * that changes on every upload, so the filename IS the version; instances with
 * no logo share the default mark and one stable token.
 */
export function iconVersion(logo?: string): string {
  return logo ? logo.replace(/[^A-Za-z0-9._-]/g, "") : "default";
}

export function buildManifest(input: {
  /** The assistant's admin-set name — what users call this portal. */
  name: string;
  /** Branding logo filename, when one is configured. */
  logo?: string;
}): WebManifest {
  const name = input.name.trim() || "AI Assistant";
  const v = iconVersion(input.logo);

  const icons: ManifestIcon[] = [];
  for (const size of MANIFEST_ICON_SIZES) {
    icons.push({
      src: iconUrl(size, { v }),
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    });
  }
  // Android masks icons to the launcher's shape, cropping roughly the outer
  // 10%. A "maskable" copy is the same art inset into its safe zone; without
  // one the launcher letterboxes the icon into a white circle.
  icons.push({
    src: iconUrl(512, { maskable: true, v }),
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  });

  return {
    // A stable id keeps this the SAME installed app when the name or start_url
    // is changed later; without it a rename can register as a second app.
    id: "/",
    name,
    short_name: shortAppName(name),
    description: `${name} — your organisation's private AI assistant.`,
    // Straight to the workspace. Signed out, middleware sends them to /login
    // and back, which is the same journey the browser makes.
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_BACKGROUND,
    icons,
  };
}
