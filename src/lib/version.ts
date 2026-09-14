import pkg from "../../package.json";

/**
 * Portal product name — the fixed OPNinfer brand shown in neutral spots
 * (e.g. the version footer). Distinct from the admin-configurable assistant
 * name, which can be "Acme AI", "Northwind Assistant", etc.
 */
export const APP_NAME = "OPNinfer";

/** Current portal version, sourced from package.json (single source of truth). */
export const APP_VERSION: string = pkg.version;

/**
 * A browser-tab title for a page, matching the root layout's "%s · OPNinfer"
 * metadata template. Next applies that template to server-rendered metadata;
 * anything setting `document.title` from the client has to apply it itself, so
 * both paths go through here rather than hard-coding the separator twice.
 */
export function pageTitle(title: string): string {
  return `${title} · ${APP_NAME}`;
}
