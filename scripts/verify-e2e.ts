/** Verify the HTTP/SSE turn persisted, then remove the e2e user. */
import { db } from "../src/lib/db";

async function main() {
  const user = await db.user.findUnique({
    where: { email: "e2e@opninfer.local" },
  });
  if (!user) throw new Error("e2e user missing");

  const convos = await db.conversation.findMany({
    where: { userId: user.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  const usage = await db.usageRecord.findMany({ where: { userId: user.id } });

  console.log(`conversations: ${convos.length}`);
  for (const c of convos) {
    console.log(`  "${c.title}" — ${c.messages.length} messages`);
    for (const m of c.messages) {
      console.log(`    [${m.role}] ${JSON.stringify(m.content.slice(0, 50))}`);
    }
  }
  console.log(`usage_records: ${usage.length}`);
  for (const u of usage) {
    console.log(
      `  ${u.provider}/${u.model}: in ${u.inputTokens} out ${u.outputTokens} cost $${u.costEstimate}`,
    );
  }

  const pass =
    convos.length === 1 &&
    convos[0].messages.length === 2 &&
    convos[0].messages[0].role === "user" &&
    convos[0].messages[1].role === "assistant" &&
    usage.length === 1;
  console.log(pass ? "\nPERSISTENCE VERIFIED ✓" : "\nPERSISTENCE MISMATCH ✗");
  if (!pass) process.exitCode = 1;

  // Cleanup: remove the e2e user; anonymised usage rows then get purged.
  await db.user.delete({ where: { id: user.id } });
  await db.usageRecord.deleteMany({ where: { userId: null } });
  console.log("cleaned up e2e user");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
