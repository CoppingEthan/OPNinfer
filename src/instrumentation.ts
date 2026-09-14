/**
 * Server startup hook — Next.js calls `register()` once per runtime at boot.
 *
 * The real work lives in `instrumentation-node.ts` and is imported ONLY under
 * the `nodejs` guard (Next's documented split pattern). That keeps Node-only
 * dependencies — the auto-backup scheduler pulls in `archiver` (`path`/`fs`) —
 * out of the Edge/middleware bundle, where those built-ins don't resolve.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
