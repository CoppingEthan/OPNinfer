import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

// Augment Auth.js types so `session.user` and the JWT carry our id + role.
declare module "next-auth" {
  interface User {
    role: Role;
    /** An admin set this password; nothing else is allowed until it changes. */
    mustChangePassword?: boolean;
  }
  interface Session {
    user: {
      id: string;
      role: Role;
      // Carried on the session because MIDDLEWARE has to act on it, and
      // middleware runs at the edge with no database. Refreshed by the
      // 60-second recheck like `role`, so an admin setting a temporary
      // password takes hold on an already-open session within the minute.
      mustChangePassword?: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    mustChangePassword?: boolean;
  }
}
