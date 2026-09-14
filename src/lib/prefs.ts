import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";

/** Who can see the in-chat token/cost stats under each reply. */
export type UsageVisibility = "everyone" | "admins" | "off";

export async function getUsageVisibility(): Promise<UsageVisibility> {
  const v = await getSetting<UsageVisibility>(SETTING_KEYS.usageVisibility);
  return v === "everyone" || v === "off" ? v : "admins"; // default: admins only
}

export async function setUsageVisibility(v: UsageVisibility): Promise<void> {
  await setSetting(SETTING_KEYS.usageVisibility, v);
}

/** Resolve whether a user of the given role should see usage stats. */
export function showUsageStats(vis: UsageVisibility, isAdmin: boolean): boolean {
  if (vis === "off") return false;
  if (vis === "everyone") return true;
  return isAdmin;
}
