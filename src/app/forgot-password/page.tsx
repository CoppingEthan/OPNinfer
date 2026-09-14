import { AuthCard } from "@/components/auth-card";
import { ForgotForm } from "./forgot-form";

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to set a new password."
    >
      <ForgotForm />
    </AuthCard>
  );
}
