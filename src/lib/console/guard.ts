import "server-only";
import { auth } from "@/auth";
import { IS_CONSOLE } from "@/lib/mode";

/**
 * Gate for every console API route.
 *
 * Middleware already refuses `/api/console/*` on a portal and requires a
 * session on the console, so this is defence in depth — but it is the layer
 * that survives a matcher edit, which is exactly how the body-cap exclusions
 * have bitten before. Returns a Response to send, or null to continue.
 */
export async function refuseNonOperator(): Promise<Response | null> {
  if (!IS_CONSOLE) return new Response(null, { status: 404 });
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Forbidden" }, { status: 403 });
  return null;
}
