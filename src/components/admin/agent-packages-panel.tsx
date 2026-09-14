import type { ImagePackages, PackageTally } from "@/lib/agent/packages-store";
import { inImage } from "@/lib/agent/packages-store";

/**
 * "What the agent reaches for" — Admin → Tools (owner ask, 2026-09-02). The
 * top installs and external fetches the Sandbox agent attempted, each marked
 * against the image's own manifest, so the admin can see at a glance which
 * common ones are worth baking into the image next. Server component: the
 * page fetches, this renders.
 */
export function AgentPackagesPanel({
  tally,
  image,
  days,
}: {
  tally: PackageTally[];
  image: ImagePackages | null;
  days: number;
}) {
  const installs = tally.filter((t) => t.kind !== "download" && t.kind !== "git");
  const fetches = tally.filter((t) => t.kind === "download" || t.kind === "git");
  const missing = installs.filter((t) => inImage(t, image) === false);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">
        Every package install and external download the Sandbox agent attempted in the
        last {days} days, most frequent first. Ones the image already ships are marked;
        anything common and <em>not</em> in the image is a candidate to bake in.
        {image ? (
          <>
            {" "}
            The image currently ships {image.python.length} Python and {image.node.length} Node
            packages, plus: {image.tools.join(", ")}.
          </>
        ) : (
          <> (The image manifest is unavailable — rebuild the sandbox image or check the broker.)</>
        )}
      </p>

      {tally.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-muted">
          Nothing recorded yet — this fills in as agents run.
        </p>
      ) : null}

      {installs.length > 0 ? (
        <TallyTable
          title="Packages"
          rows={installs}
          badge={(t) => {
            const v = inImage(t, image);
            return v === true ? (
              <span className="text-emerald-600 dark:text-emerald-400">in image ✓</span>
            ) : v === false ? (
              <span className="text-amber-600 dark:text-amber-400">not in image</span>
            ) : (
              <span className="text-muted">—</span>
            );
          }}
        />
      ) : null}

      {fetches.length > 0 ? (
        <TallyTable title="External downloads & clones" rows={fetches} badge={() => null} />
      ) : null}

      {missing.length > 0 ? (
        <p className="text-xs text-muted">
          Candidates to bake in:{" "}
          {missing
            .slice(0, 8)
            .map((t) => `${t.name} (${t.kind}, ${t.uses}×)`)
            .join(" · ")}
          {" — "}add them to <span className="font-mono">docker/sandbox/Dockerfile</span> and redeploy.
        </p>
      ) : null}
    </div>
  );
}

function TallyTable({
  title,
  rows,
  badge,
}: {
  title: string;
  rows: PackageTally[];
  badge: (t: PackageTally) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{title}</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 text-right font-medium">Uses</th>
            <th className="px-3 py-2 text-right font-medium">Chats</th>
            <th className="px-3 py-2 font-medium">Last</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.kind}:${t.name}`} className="border-t border-border" data-package-row={`${t.kind}:${t.name}`}>
              <td className="px-3 py-1.5 font-mono">{t.name}</td>
              <td className="px-3 py-1.5 text-muted">{t.kind}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{t.uses}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{t.chats}</td>
              <td className="px-3 py-1.5 text-muted">{t.lastAt.toISOString().slice(0, 10)}</td>
              <td className="px-3 py-1.5">{badge(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
