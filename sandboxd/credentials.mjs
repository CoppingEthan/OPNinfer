/**
 * Is this file a Claude sign-in worth keeping?
 *
 * Its own module so it can be unit-tested — index.mjs opens a Docker socket
 * and a listening server the moment it is imported, and this decision is far
 * too consequential to be checked only by reading it.
 *
 * THE BUG IT EXISTS FOR (found live, 2026-09-07, while fixing the eight-hourly
 * sign-outs). When the CLI's refresh FAILS — which is exactly what happens to
 * whichever container lost the race after Anthropic rotated the refresh token
 * — it does not leave the old credential alone. It rewrites the file with
 * every field present and the two tokens BLANKED:
 *
 *   good:   538 bytes, accessToken "sk-ant-oat01-…", refreshToken "sk-ant-ort01-…"
 *   after:  290 bytes, accessToken "",               refreshToken ""
 *
 * The old guard only asked whether the file contained "claudeAiOauth", which
 * that wreckage does — so the broker copied it back over the shared volume and
 * a transient race became a permanent sign-out for every chat on the instance,
 * repairable only by running the login again. That is the shape of "we get
 * signed out all the time".
 *
 * So: a credential is only synced back if it actually carries both tokens.
 */

/** @param {unknown} parsed  the parsed .credentials.json */
export function isUsableCredential(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const oauth = /** @type {Record<string, unknown>} */ (parsed).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return false;
  const { accessToken, refreshToken } = /** @type {Record<string, unknown>} */ (oauth);
  // Both, not either: an access token alone expires in hours with no way to
  // renew it, which would replace one outage with a slower one.
  return (
    typeof accessToken === "string" &&
    accessToken.trim() !== "" &&
    typeof refreshToken === "string" &&
    refreshToken.trim() !== ""
  );
}

/** Parse-and-judge, for callers holding raw bytes. Never throws. */
export function readUsableCredential(text) {
  try {
    const parsed = JSON.parse(text);
    return isUsableCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
