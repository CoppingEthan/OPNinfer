import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import { Providers } from "./providers";
import { getBranding, logoUrl } from "@/lib/branding";
import { IS_CONSOLE } from "@/lib/mode";
import { BrandingProvider } from "@/components/branding";
import { PwaRegister } from "@/components/pwa-register";
import { APPLE_TOUCH_ICON_SIZE, iconUrl } from "@/lib/pwa";
import "./globals.css";

/** Build a CSS override for the admin accent colour (validated as hex on save). */
function accentCss(accent?: string, accentDark?: string): string {
  const hex = (v?: string) => (/^#[0-9a-fA-F]{3,8}$/.test(v ?? "") ? v : null);
  const light = hex(accent);
  const dark = hex(accentDark) ?? light;
  let css = "";
  if (light)
    css += `:root{--accent:${light};--accent-hover:color-mix(in srgb,${light} 85%,black);--ring:${light};}`;
  if (dark)
    css += `.dark{--accent:${dark};--accent-hover:color-mix(in srgb,${dark} 80%,white);--ring:${dark};}`;
  return css;
}

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "OPNinfer",
    template: "%s · OPNinfer",
  },
  description:
    "Private, self-hosted, multi-user AI chat for OpenAI, Anthropic, and Google models.",
  applicationName: "OPNinfer",
  icons: {
    icon: "/icon.svg",
    // iOS never reads the manifest for this one; it wants a raster PNG from a
    // <link>, and composites transparency onto black, so the route flattens it.
    apple: iconUrl(APPLE_TOUCH_ICON_SIZE),
  },
  // Installable to a home screen. The name, description and icons come from
  // the manifest, which is per instance (src/app/manifest.webmanifest) — this
  // half is the same for every portal and needs no database.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    // "default" keeps iOS drawing its own status bar ABOVE the page rather
    // than letting the page run under it, so the only inset that needs
    // handling is the home indicator at the bottom (see .oi-safe-b).
    statusBarStyle: "default",
  },
  // `capable: true` above renders only the modern `mobile-web-app-capable`:
  // Next follows Chrome in treating the apple-prefixed name as deprecated and
  // no longer emits it at all (checked against the rendered head, not the
  // docs). iOS before 16.4 doesn't read `display` out of the manifest and
  // needs this one to open without Safari's chrome, so it is written by hand.
  // Adding `mobile-web-app-capable` here too would simply duplicate the tag.
  other: { "apple-mobile-web-app-capable": "yes" },
  robots: { index: false, follow: false }, // private app — keep out of search
};

// The root layout reads admin branding from the DB on every route, and the app
// is entirely behind auth with no cacheable pages. Force dynamic rendering so
// (a) the build never prerenders a DB call against an unreachable database
// (auth pages like /forgot-password would otherwise fail the build), and
// (b) runtime branding (login-screen logo/accent) is always current.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f10" },
  ],
  width: "device-width",
  initialScale: 1,
  // Installed to a home screen, the page owns the whole screen including the
  // rounded corners and the home indicator. Without this iOS letterboxes the
  // layout inside the safe area and paints the gaps a flat colour; with it the
  // sidebar and background reach the edges, and the composer takes the bottom
  // inset as padding instead (.oi-safe-b in globals.css).
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The operator console runs from this same image but has NO DATABASE of its
  // own — it only ever reads the portals'. So it takes the default mark and
  // accent rather than looking up branding that doesn't exist here.
  const branding = IS_CONSOLE ? {} : await getBranding();
  const css = accentCss(branding.accent, branding.accentDark);

  return (
    // suppressHydrationWarning: next-themes sets the class on <html> client-side.
    <html lang="en" className={sora.variable} suppressHydrationWarning>
      <body>
        {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
        <Providers>
          <BrandingProvider logoUrl={logoUrl(branding)}>
            {children}
          </BrandingProvider>
          <PwaRegister />
        </Providers>
      </body>
    </html>
  );
}
