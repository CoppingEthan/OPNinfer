"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { DialogProvider } from "@/components/ui/dialog";

/**
 * Client-side providers. next-themes handles light/dark with the system
 * preference as default (§7) and persists the choice in localStorage.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <DialogProvider>{children}</DialogProvider>
    </ThemeProvider>
  );
}
