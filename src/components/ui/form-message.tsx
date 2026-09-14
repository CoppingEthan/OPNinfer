export function FormMessage({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
      >
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p
        role="status"
        className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
      >
        {success}
      </p>
    );
  }
  return null;
}
