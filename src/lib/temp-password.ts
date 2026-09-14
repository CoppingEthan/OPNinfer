import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/hash";
import { sendMail } from "@/lib/mailer";
import { newPasswordEmail } from "@/lib/emails";
import { appUrl } from "@/lib/app-url";

/**
 * Issue a one-shot temporary password for an account.
 *
 * Extracted 2026-09-09 so there is exactly ONE implementation of "give this
 * person a password they can sign in with once". Admin → Users has done this
 * since 2026-09-07; the login screen now does it too for an account whose
 * password has never worked (see `recovery.ts`), and two copies of a rule
 * this consequential would drift.
 *
 * Everything about it is deliberate:
 *  - `mustChangePassword` — it works exactly once and then middleware marches
 *    them to /change-password. A password a second person has seen, or that
 *    travelled through an inbox, must not stay live.
 *  - `passwordChangedAt` — ends every session issued before now, which is the
 *    correct response if the reason for the reset was a lost account.
 *  - the account is verified as a side effect: an unverified one cannot sign
 *    in at all, so issuing a password it could not use would be a dead end.
 *
 * Authorisation and auditing belong to the CALLER — this does neither, and
 * must never be reachable from anywhere that has not decided it is allowed.
 */
export async function issueTemporaryPassword(
  userId: string,
  opts: { sendEmail?: boolean } = {},
): Promise<{ password: string; emailed: boolean; email: string } | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) return null;

  // ~16 URL-safe characters: long enough that it cannot be guessed in the
  // window it is alive, short enough to read down a phone.
  const password = randomBytes(12).toString("base64url");
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      emailVerified: user.emailVerified ?? new Date(),
      passwordChangedAt: new Date(),
      mustChangePassword: true,
    },
  });

  // THE ORDER MATTERS AND SO DOES THE CATCH. The password is already changed
  // by the time we try to send it, so a transport error must not throw out of
  // here: the caller would report a failure while the account quietly had a
  // new password nobody had been told. `sendMail` does not catch (a bad host,
  // a refused recipient and an auth failure all throw), so this does — the
  // caller gets `emailed: false`, which every screen turns into "we could not
  // send it, ask your administrator", and the password itself is still
  // returned so an admin can pass it on by hand.
  let emailed = false;
  if (opts.sendEmail !== false) {
    try {
      const mail = await newPasswordEmail(password, appUrl("/login"));
      ({ delivered: emailed } = await sendMail({
        to: user.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }));
    } catch {
      emailed = false;
    }
  }

  return { password, emailed, email: user.email };
}
