import { requireUser } from "@/lib/auth-helpers";
import { myWorkflows } from "@/app/actions/workflows";
import { WorkflowsView } from "@/components/workflows/workflows-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workflows" };

export default async function WorkflowsPage() {
  await requireUser();
  // Seeds the two examples for anyone who has none — on this page only, never
  // on a chat turn, so nobody is handed workflows they never asked to see.
  const workflows = await myWorkflows();
  return <WorkflowsView initial={workflows} />;
}
