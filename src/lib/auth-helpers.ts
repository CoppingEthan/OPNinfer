import { auth } from "@/auth";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Returns the current session user or throws. Use in server actions/routes. */
export async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError();
  return session.user;
}

/** Returns the current admin user or throws. */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") throw new UnauthorizedError("Admin access required.");
  return user;
}
