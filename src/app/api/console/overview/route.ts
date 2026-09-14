import { refuseNonOperator } from "@/lib/console/guard";
import { getOverview, parseOverviewRange } from "@/lib/console/overview";

export const dynamic = "force-dynamic";

/** GET /api/console/overview?range=day|week|month — the front page, for polling. */
export async function GET(req: Request) {
  const refusal = await refuseNonOperator();
  if (refusal) return refusal;

  const range = parseOverviewRange(new URL(req.url).searchParams.get("range"));
  return Response.json(await getOverview(range));
}
