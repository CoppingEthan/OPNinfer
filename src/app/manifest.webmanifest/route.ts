import { getAssistantConfig, DEFAULT_ASSISTANT_NAME } from "@/lib/assistant";
import { getBranding } from "@/lib/branding";
import { IS_CONSOLE } from "@/lib/mode";
import { buildManifest } from "@/lib/pwa";

// Never prerendered: it reads this instance's branding, and the build runs
// against a database that isn't there (the same reason the root layout is
// force-dynamic).
export const dynamic = "force-dynamic";

/**
 * GET /manifest.webmanifest — the installable-app manifest for THIS portal.
 *
 * PUBLIC, and it has to be: browsers fetch a manifest with credentials
 * omitted, so behind the auth middleware this would answer with the login
 * page's HTML and the install would silently offer nothing. It carries the
 * assistant's name and logo, which the login screen shows to anyone anyway.
 */
export async function GET() {
  // The operator console runs from this image with NO DATABASE of its own, so
  // it takes the default identity rather than querying one that isn't there.
  const [assistant, branding] = IS_CONSOLE
    ? [{ name: DEFAULT_ASSISTANT_NAME }, {}]
    : await Promise.all([getAssistantConfig(), getBranding()]);

  const manifest = buildManifest({
    name: assistant.name,
    logo: branding.logo,
  });

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // Revalidated on every load: an admin who changes the assistant's name
      // expects the next install to use it, and this is one small request
      // made once per page, not per asset.
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
