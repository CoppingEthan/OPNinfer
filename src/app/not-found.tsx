import Link from "next/link";
import { BrandLogo } from "@/components/branding";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <BrandLogo variant="mark" className="h-10 w-10 text-foreground" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        The page you’re looking for doesn’t exist or you don’t have access to it.
      </p>
      <Link
        href="/chat"
        className="mt-6 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
      >
        Back to chat
      </Link>
    </div>
  );
}
