import type { ReactNode } from "react";
import { BrandLogo } from "@/components/branding";
import { ThemeToggle } from "@/components/theme-toggle";

/** Centered card layout shared by all auth screens. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center text-center">
            <BrandLogo variant="mark" className="h-10 w-10 text-foreground" />
            <h1 className="mt-4 text-xl font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1 text-sm text-muted">{subtitle}</p>
            ) : null}
          </div>
          <div className="rounded-2xl border border-border bg-background p-6 shadow-sm">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
