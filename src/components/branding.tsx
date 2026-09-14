"use client";

import { createContext, useContext, useState } from "react";
import { LogoFull, LogoMark } from "@/components/logo";

const BrandingContext = createContext<{ logoUrl: string | null }>({
  logoUrl: null,
});

export function BrandingProvider({
  logoUrl,
  children,
}: {
  logoUrl: string | null;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={{ logoUrl }}>
      {children}
    </BrandingContext.Provider>
  );
}

/**
 * Portal logo. Renders the admin-uploaded image when set, otherwise the default
 * OPNinfer mark/wordmark. Falls back to the default if the image fails to load.
 */
export function BrandLogo({
  variant = "full",
  className = "",
}: {
  variant?: "full" | "mark";
  className?: string;
}) {
  const { logoUrl } = useContext(BrandingContext);
  const [failed, setFailed] = useState(false);

  if (logoUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt="OPNinfer"
        className={`w-auto object-contain ${className}`}
        onError={() => setFailed(true)}
      />
    );
  }
  return variant === "mark" ? (
    <LogoMark className={className} />
  ) : (
    <LogoFull className={className} />
  );
}
