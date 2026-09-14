import { getSetting, setSetting, SETTING_KEYS } from "./settings";

/** Admin-configurable portal branding (spec §9): logo + accent colour. */
export interface Branding {
  /** Branding-asset filename for the logo (served at /api/branding/<name>). */
  logo?: string;
  /** Accent hex for the light theme (e.g. "#b74b7a"). */
  accent?: string;
  /** Accent hex for the dark theme; falls back to `accent` if unset. */
  accentDark?: string;
}

export async function getBranding(): Promise<Branding> {
  return (await getSetting<Branding>(SETTING_KEYS.branding)) ?? {};
}

export async function setBranding(patch: Partial<Branding>): Promise<void> {
  const current = await getBranding();
  // Allow explicit clearing by passing undefined for a key.
  const merged: Branding = { ...current, ...patch };
  await setSetting(SETTING_KEYS.branding, merged);
}

/** URL the browser uses to fetch the logo, or null when none is configured. */
export function logoUrl(b: Branding): string | null {
  return b.logo ? `/api/branding/${b.logo}` : null;
}
