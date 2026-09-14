"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./button";

/** Submit button that reflects the parent form's pending state. */
export function SubmitButton({
  children,
  pendingText,
  className = "",
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className}>
      {pending ? (pendingText ?? "Please wait…") : children}
    </Button>
  );
}
