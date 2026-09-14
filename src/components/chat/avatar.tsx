/**
 * User avatar: the uploaded profile picture when set, otherwise initials on an
 * accent tint. Shared by the sidebar chip, the top-right menu, and settings.
 */
export function Avatar({
  name,
  email,
  image,
  className = "h-8 w-8",
  textClassName = "text-xs",
}: {
  name?: string;
  email?: string;
  image?: string | null;
  className?: string;
  textClassName?: string;
}) {
  const base = (name?.trim() || email?.split("@")[0] || "U").trim();
  const initials =
    base
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "U";

  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={`/api/avatar/${image}`}
        alt=""
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent ${className} ${textClassName}`}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
