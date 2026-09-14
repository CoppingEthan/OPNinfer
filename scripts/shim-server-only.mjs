// Resolve hook: neutralize the `server-only`/`client-only` marker packages so
// server modules can be imported from a plain Node harness (they exist only as
// transitive deps of Next and aren't resolvable at the repo root under pnpm).
export async function resolve(specifier, context, next) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: new URL("./empty.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
