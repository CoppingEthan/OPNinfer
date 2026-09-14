import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ICON_SIZES,
  APPLE_TOUCH_ICON_SIZE,
  MANIFEST_ICON_SIZES,
  buildManifest,
  iconUrl,
  iconVersion,
  shortAppName,
} from "./pwa";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("shortAppName", () => {
  it("leaves a label that already fits", () => {
    expect(shortAppName("AI Assistant")).toBe("AI Assistant"); // exactly 12
    expect(shortAppName("Acme AI")).toBe("Acme AI");
  });

  it("drops whole words from the end rather than truncating mid-word", () => {
    expect(shortAppName("ACME AI Assistant")).toBe("ACME AI");
    expect(shortAppName("Globex AI Assistant")).toBe("Globex AI");
    expect(shortAppName("Northwind AI Assistant")).toBe("Northwind AI");
  });

  it("cuts a single word that cannot be shortened any other way", () => {
    expect(shortAppName("Supercalifragilistic")).toBe("Supercalifra");
    expect(shortAppName("Supercalifragilistic").length).toBe(12);
  });

  it("normalises whitespace", () => {
    expect(shortAppName("  Acme   AI  ")).toBe("Acme AI");
  });

  it("never returns an empty label for a non-empty name", () => {
    expect(shortAppName("A&B Marketing AI")).toBe("A&B");
    expect(shortAppName("x")).toBe("x");
  });
});

describe("iconVersion", () => {
  it("uses the logo filename, which changes on every upload", () => {
    expect(iconVersion("logo-8f3a.png")).toBe("logo-8f3a.png");
  });

  it("is stable when no logo is configured", () => {
    expect(iconVersion()).toBe("default");
    expect(iconVersion("")).toBe("default");
  });

  it("strips anything that would need escaping in a query string", () => {
    expect(iconVersion("a b/../c?d.png")).toBe("ab..cd.png");
  });
});

describe("buildManifest", () => {
  const manifest = buildManifest({ name: "ACME AI Assistant", logo: "logo-1.png" });

  it("carries the instance's own assistant name, not the product name", () => {
    // One image serves four branded portals; a home-screen icon saying
    // "OPNinfer" on a client's phone is the leak this whole route exists to
    // avoid.
    expect(manifest.name).toBe("ACME AI Assistant");
    expect(manifest.short_name).toBe("ACME AI");
    expect(manifest.description).toContain("ACME AI Assistant");
    expect(JSON.stringify(manifest)).not.toContain("OPNinfer");
  });

  it("falls back to a sensible name when the assistant is unnamed", () => {
    const m = buildManifest({ name: "   " });
    expect(m.name).toBe("AI Assistant");
    expect(m.short_name).toBe("AI Assistant");
  });

  it("is installable: standalone, a scope covering the app, a stable id", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/chat");
    // A stable id keeps this the same installed app across a rename.
    expect(manifest.id).toBe("/");
  });

  it("advertises the two sizes Chrome requires, plus a maskable one", () => {
    const any = manifest.icons.filter((i) => i.purpose === "any");
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].sizes).toBe("512x512");
    expect(manifest.icons.every((i) => i.type === "image/png")).toBe(true);
  });

  it("only ever advertises sizes the icon route will actually render", () => {
    // A manifest naming a size the route refuses is an install that fails with
    // a 400 nothing surfaces — the sizes have to come from one list.
    for (const icon of manifest.icons) {
      const size = Number(new URL(icon.src, "http://x").searchParams.get("size"));
      expect(ALLOWED_ICON_SIZES).toContain(size);
    }
  });

  it("versions every icon URL so a re-uploaded logo is picked up", () => {
    for (const icon of manifest.icons) {
      expect(new URL(icon.src, "http://x").searchParams.get("v")).toBe("logo-1.png");
    }
  });

  it("uses valid colours for the splash screen", () => {
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("iconUrl", () => {
  it("names the size, and the maskable variant only when asked", () => {
    expect(iconUrl(192)).toBe("/api/pwa/icon?size=192");
    expect(iconUrl(512, { maskable: true })).toBe("/api/pwa/icon?size=512&maskable=1");
    expect(iconUrl(180, { v: "x.png" })).toBe("/api/pwa/icon?size=180&v=x.png");
  });
});

/**
 * The rest is pinned from SOURCE. Every one of these is a failure that would
 * look like nothing at all: an install that quietly never offers itself, or a
 * service worker doing something it must never do on a device we cannot reach.
 */
describe("the PWA plumbing that has no runtime symptom", () => {
  it("middleware lets the manifest, the worker and the icons through unauthenticated", () => {
    // A browser fetches a manifest and its icons with credentials OMITTED. Left
    // inside the auth matcher, each one answers with the login page instead and
    // the browser simply never offers to install — no error, nothing logged.
    const src = read("src/middleware.ts");
    const matcher = src.slice(src.indexOf("matcher:"));
    // String.raw: the matcher is a regex inside a JS string, so the file's own
    // bytes carry a doubled backslash.
    expect(matcher).toContain(String.raw`manifest\\.webmanifest`);
    expect(matcher).toContain(String.raw`sw\\.js`);
    expect(matcher).toContain("api/pwa");
  });

  it("the manifest route is force-dynamic", () => {
    // It reads this instance's branding. Prerendered, the build would run that
    // query against a database that isn't there — the same trap the root
    // layout's force-dynamic exists for.
    const src = read("src/app/manifest.webmanifest/route.ts");
    expect(src).toMatch(/export const dynamic\s*=\s*"force-dynamic"/);
  });

  it("Dockerfile copies public/ into the runtime image", () => {
    // The standalone build traces JS imports only. public/sw.js is served from
    // disk and public/icon.png is READ from disk by the icon route, so without
    // this line the worker 404s and every icon is a 500 — in production only.
    const dockerfile = read("Dockerfile");
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).not.toBe("");
    expect(runner).toMatch(/^COPY\s+--from=builder\b.*\s\S*\/public\s+\S+$/m);
  });

  it("the root layout links the manifest and an apple-touch-icon", () => {
    // iOS never reads the manifest for its home-screen icon; without the
    // <link> it screenshots the page instead.
    const src = read("src/app/layout.tsx");
    expect(src).toContain('manifest: "/manifest.webmanifest"');
    expect(src).toMatch(/apple:\s*iconUrl\(APPLE_TOUCH_ICON_SIZE\)/);
    expect(src).toMatch(/viewportFit:\s*"cover"/);
    // Next renders only the modern `mobile-web-app-capable` for
    // `appleWebApp.capable` and has dropped the apple-prefixed name; iOS
    // before 16.4 opens in Safari's chrome without it, so it is written by
    // hand and must stay that way.
    expect(src).toContain('"apple-mobile-web-app-capable": "yes"');
  });

  describe("the service worker", () => {
    const sw = read("public/sw.js");

    it("caches nothing", () => {
      // Every page here is behind auth and rendered per request: a cached
      // document is one person's chat in another person's browser, and a
      // worker outlives the session that put it there.
      expect(sw).not.toMatch(/\bcaches\.open\b/);
      expect(sw).not.toMatch(/\.addAll\(/);
      expect(sw).not.toMatch(/\bcache\.put\(/);
    });

    it("never touches the API", () => {
      // The chat stream is an SSE response held open for a whole reply;
      // uploads and signed downloads live there too.
      expect(sw).toMatch(/pathname\.startsWith\("\/api\/"\)\s*\)\s*return/);
    });

    it("answers navigations only, and only GET, and only same-origin", () => {
      expect(sw).toMatch(/req\.method\s*!==\s*"GET"\s*\)\s*return/);
      expect(sw).toMatch(/url\.origin\s*!==\s*self\.location\.origin\s*\)\s*return/);
      // Next's client-side routing fetches RSC payloads from this origin; they
      // are not navigations and must never be handed an HTML error page.
      expect(sw).toMatch(/req\.mode\s*!==\s*"navigate"\s*\)\s*return/);
    });

    it("falls back only when the network itself failed", () => {
      // A 500 is the server's to explain; only a rejected fetch is "offline".
      expect(sw).toMatch(/fetch\(req\)\.catch\(/);
    });
  });
});

describe("icon sizes", () => {
  it("covers what each platform actually asks for", () => {
    expect(APPLE_TOUCH_ICON_SIZE).toBe(180);
    expect([...MANIFEST_ICON_SIZES]).toEqual([192, 512]);
    expect([...ALLOWED_ICON_SIZES].sort((a, b) => a - b)).toEqual([180, 192, 512]);
  });
});
