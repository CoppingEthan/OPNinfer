import { redirect } from "next/navigation";
import { IS_CONSOLE } from "@/lib/mode";

// The workspace lives at /chat; the root just forwards there. Auth is enforced
// by middleware, so an unauthenticated visitor is sent to /login first.
// In console mode there is no chat — the overview is the home page.
export default function Home() {
  redirect(IS_CONSOLE ? "/console" : "/chat");
}
