import { getBranding } from "@/lib/branding";
import { getAssistantConfig } from "@/lib/assistant";
import { appUrl } from "@/lib/app-url";

/**
 * Branded transactional emails. A single responsive, table-based HTML layout
 * (inline styles for client compatibility) themed with the portal's logo +
 * accent colour, so invites / resets look like the product, not generic text.
 */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

interface Brand {
  name: string;
  logoUrl: string | null;
  accent: string;
}

async function brand(): Promise<Brand> {
  const [b, assistant] = await Promise.all([getBranding(), getAssistantConfig()]);
  const logo = b.logo ?? assistant.logo;
  return {
    name: assistant.name || "OPNinfer",
    logoUrl: logo ? appUrl(`/api/branding/${logo}`) : null,
    accent: b.accent && /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : "#b74b7a",
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function layout(o: {
  brand: Brand;
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  callout?: string;
  note?: string;
}): string {
  const { brand: b } = o;
  const header = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="40" style="height:40px;max-height:40px;width:auto;display:block;margin:0 auto;" />`
    : `<div style="font-size:22px;font-weight:700;color:#111;">${esc(b.name)}</div>`;

  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 8px;">
         <tr><td style="border-radius:10px;background:${b.accent};">
           <a href="${esc(o.button.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(o.button.label)}</a>
         </td></tr>
       </table>`
    : "";

  const callout = o.callout
    ? `<div style="margin:20px 0;padding:14px 16px;border-radius:10px;background:#f4f4f5;border:1px solid #e4e4e7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;color:#111;word-break:break-all;">${esc(o.callout)}</div>`
    : "";

  const paras = o.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3f3f46;">${p}</p>`)
    .join("");

  const note = o.note
    ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa;">${esc(o.note)}</p>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafafa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #ececec;border-radius:16px;overflow:hidden;">
        <tr><td style="height:6px;background:${b.accent};"></td></tr>
        <tr><td style="padding:32px 36px 8px;text-align:center;">${header}</td></tr>
        <tr><td style="padding:8px 36px 32px;">
          <h1 style="margin:12px 0 16px;font-size:21px;font-weight:700;color:#111;text-align:center;">${esc(o.heading)}</h1>
          ${paras}${callout}
          <div style="text-align:center;">${button}</div>
          ${note}
        </td></tr>
        <tr><td style="padding:18px 36px;border-top:1px solid #f0f0f0;text-align:center;font-size:12px;color:#a1a1aa;">
          Sent by ${esc(b.name)} · automated message, please don't reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function inviteEmail(link: string, role: string): Promise<EmailContent> {
  const b = await brand();
  return {
    subject: `You're invited to ${b.name}`,
    text: `You've been invited to ${b.name}${role === "admin" ? " as an admin" : ""}.\n\nSet up your account (link valid for 7 days):\n${link}\n`,
    html: layout({
      brand: b,
      heading: `You're invited to ${b.name}`,
      paragraphs: [
        `You've been invited to join <strong>${esc(b.name)}</strong>${role === "admin" ? " as an <strong>admin</strong>" : ""}. Set your password to activate your account.`,
      ],
      button: { label: "Set up your account", url: link },
      note: "This invite link is valid for 7 days. If you weren't expecting it, you can ignore this email.",
    }),
  };
}

export async function resetEmail(link: string): Promise<EmailContent> {
  const b = await brand();
  return {
    subject: `Reset your ${b.name} password`,
    text: `Reset your ${b.name} password (link valid for 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: layout({
      brand: b,
      heading: "Reset your password",
      paragraphs: ["We received a request to reset your password. Click below to choose a new one."],
      button: { label: "Reset password", url: link },
      note: "This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.",
    }),
  };
}

/**
 * Error alert (Admin → SMTP → Error alerts). Deliberately plainer than the
 * user-facing emails: whoever gets this is on call, so the useful facts go
 * near the top and the details JSON is capped so a huge payload can't make
 * the message unreadable (or get it rejected by the relay).
 */
export async function errorAlertEmail(
  event: {
    level: string;
    category: string;
    message: string;
    details?: unknown;
    userId?: string | null;
    createdAt: string;
  },
  suppressed: number,
  opts: { test?: boolean } = {},
): Promise<EmailContent> {
  const b = await brand();
  const when = new Date(event.createdAt).toUTCString();
  const logsUrl = appUrl("/admin/logs");

  let details = "";
  try {
    details = event.details ? JSON.stringify(event.details, null, 2) : "";
  } catch {
    details = "(details could not be serialized)";
  }
  if (details.length > 4000) details = `${details.slice(0, 4000)}\n… truncated`;

  const repeat =
    suppressed > 0
      ? `${suppressed} further occurrence${suppressed === 1 ? "" : "s"} were suppressed since the last alert about this.`
      : "";

  const facts: [string, string][] = [
    ["When", when],
    ["Area", event.category],
    ["Message", event.message],
  ];
  if (event.userId) facts.push(["User", event.userId]);

  const text =
    `${b.name} reported an error.\n\n` +
    facts.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (repeat ? `\n\n${repeat}` : "") +
    (details ? `\n\nDetails:\n${details}\n` : "\n") +
    `\nFull log: ${logsUrl}\n`;

  const rows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;font-size:13px;color:#71717a;white-space:nowrap;vertical-align:top;">${esc(k)}</td>` +
        `<td style="padding:6px 0;font-size:14px;color:#18181b;word-break:break-word;">${esc(v)}</td></tr>`,
    )
    .join("");

  const testNote = opts.test
    ? "TEST SEND — sent by hand from the admin panel. Nothing is actually wrong; this is what the real alert looks like."
    : "";
  return {
    subject: `${opts.test ? "[TEST] " : ""}[${b.name}] ${event.category === "agent" && /plan/i.test(event.message) ? "Sandbox plan" : `Error in ${event.category}`}: ${event.message.slice(0, 80)}`,
    text: (testNote ? `${testNote}

` : "") + text,
    html: layout({
      brand: b,
      heading: opts.test ? "An error was logged (TEST)" : "An error was logged",
      paragraphs: [
        ...(testNote
          ? [`<div style="margin:0 0 12px;padding:12px 16px;border-radius:12px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:14px;font-weight:600;">${esc(testNote)}</div>`]
          : []),
        `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">${rows}</table>`,
        ...(repeat ? [`<em style="color:#71717a;">${esc(repeat)}</em>`] : []),
        ...(details
          ? [
              `<pre style="margin:8px 0 0;padding:12px;border-radius:10px;background:#f4f4f5;border:1px solid #e4e4e7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;color:#3f3f46;white-space:pre-wrap;word-break:break-word;">${esc(details)}</pre>`,
            ]
          : []),
      ],
      button: { label: "Open the log", url: logsUrl },
      note: "You're receiving this because error alerts are switched on for this portal (Admin → SMTP). Repeated identical errors are grouped.",
    }),
  };
}

/**
 * The Friday weekly report. Uses its own wider shell rather than `layout()`:
 * that one is a 480px card built for a heading and a button, and spend/error
 * tables squeezed into it are unreadable on a phone.
 */
function reportShell(b: Brand, heading: string, subtitle: string, sections: string): string {
  const header = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="34" style="height:34px;max-height:34px;width:auto;display:block;" />`
    : `<div style="font-size:19px;font-weight:700;color:#111;">${esc(b.name)}</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafafa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border:1px solid #ececec;border-radius:16px;overflow:hidden;">
        <tr><td style="height:6px;background:${b.accent};"></td></tr>
        <tr><td style="padding:24px 28px 0;">${header}</td></tr>
        <tr><td style="padding:16px 28px 28px;">
          <h1 style="margin:6px 0 4px;font-size:20px;font-weight:700;color:#111;">${esc(heading)}</h1>
          <p style="margin:0 0 20px;font-size:13px;color:#71717a;">${esc(subtitle)}</p>
          ${sections}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #f0f0f0;font-size:12px;color:#a1a1aa;">
          Sent by ${esc(b.name)} · weekly report (Admin → SMTP) · automated message, please don't reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-GB");

function statTile(label: string, value: string, note = ""): string {
  return `<td style="padding:12px 14px;border:1px solid #ececec;border-radius:12px;vertical-align:top;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa;">${esc(label)}</div>
      <div style="margin-top:4px;font-size:19px;font-weight:700;color:#111;">${esc(value)}</div>
      ${note ? `<div style="margin-top:2px;font-size:12px;color:#71717a;">${esc(note)}</div>` : ""}
    </td>`;
}

function sectionTitle(t: string): string {
  return `<h2 style="margin:26px 0 10px;font-size:14px;font-weight:700;color:#111;">${esc(t)}</h2>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<p style="margin:0;font-size:13px;color:#71717a;">Nothing to report.</p>`;
  }
  const head = headers
    .map(
      (h, i) =>
        `<th style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa;text-align:${i === 0 ? "left" : "right"};border-bottom:1px solid #ececec;">${esc(h)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (c, i) =>
              `<td style="padding:7px 8px;font-size:13px;color:#3f3f46;text-align:${i === 0 ? "left" : "right"};border-bottom:1px solid #f6f6f6;word-break:break-word;">${esc(c)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function weeklyReportEmail(report: {
  from: Date;
  to: Date;
  spend: {
    cost: number;
    previousCost: number;
    requests: number;
    activeUsers: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  /** Sandbox agent runs on the operator's Claude plan — not billed; their
   *  API-rate value is what the plan saved. Optional for older callers. */
  subscription?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    notionalCost: number;
    previousNotionalCost: number;
    rateLimitWaits: number;
    sessions?: number;
    users?: number;
    apiFallback?: { requests: number; cost: number };
    planUsage?: { window: string; label: string; percentUsed?: number; resetsAt?: number }[];
    topPackages?: { name: string; kind: string; uses: number }[];
  };
  byUser: { label: string; cost: number; requests: number }[];
  byModel: { label: string; cost: number; requests: number }[];
  errors: { category: string; message: string; count: number; lastAt: Date }[];
  errorTotal: number;
  health: {
    pendingFiles: number;
    stuckFiles: number;
    failedFiles: number;
    ingestedFiles: number;
    engines: { name: string; ok: boolean; detail: string }[];
  };
}, opts: { test?: boolean } = {}): Promise<EmailContent> {
  const b = await brand();
  const day = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
  const period = `${day(report.from)} – ${day(report.to)}`;

  const delta = report.spend.cost - report.spend.previousCost;
  const deltaNote =
    report.spend.previousCost > 0
      ? `${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))} vs last week`
      : "no spend last week";

  // Health verdict up top: the whole point is that nobody should have to read
  // a table to find out something is broken.
  const enginesDown = report.health.engines.filter((e) => !e.ok);
  const problems: string[] = [];
  if (report.health.stuckFiles > 0)
    problems.push(`${report.health.stuckFiles} file(s) stuck mid-ingestion — the worker may be down`);
  if (enginesDown.length > 0)
    problems.push(`${enginesDown.map((e) => e.name).join(", ")} unreachable`);
  if (report.errorTotal > 0) problems.push(`${report.errorTotal} error(s) logged`);
  const allWell = problems.length === 0;

  const banner = `<div style="padding:12px 14px;border-radius:12px;background:${allWell ? "#f0fdf4" : "#fef2f2"};border:1px solid ${allWell ? "#bbf7d0" : "#fecaca"};font-size:14px;color:${allWell ? "#166534" : "#991b1b"};">
      <strong>${allWell ? "All clear." : "Needs a look."}</strong> ${
        allWell
          ? "No errors logged, ingestion healthy, all services reachable."
          : esc(problems.join(" · "))
      }
    </div>`;

  const tiles = `<table role="presentation" cellpadding="0" cellspacing="6" style="width:100%;margin-top:14px;border-collapse:separate;"><tr>
      ${statTile("Spend", money(report.spend.cost), deltaNote)}
      ${statTile("Requests", num(report.spend.requests), `${report.spend.activeUsers} active user(s)`)}
      ${statTile("Tokens out", num(report.spend.outputTokens), `${num(report.spend.inputTokens)} in · ${num(report.spend.cachedTokens)} cached`)}
    </tr></table>`;

  // Only present once a Sandbox has run on the plan — a client instance on
  // API keys never sees this block.
  const sub = report.subscription;
  const subDelta = sub && sub.previousNotionalCost > 0
    ? `${sub.notionalCost - sub.previousNotionalCost >= 0 ? "+" : "−"}${money(Math.abs(sub.notionalCost - sub.previousNotionalCost))} vs last week`
    : "";
  const planLine = (sub?.planUsage ?? [])
    .map((w) => `${w.label}: ${typeof w.percentUsed === "number" ? `${w.percentUsed}% used` : "no percentage"}`)
    .join(" · ");
  const subscription =
    sub && sub.requests > 0
      ? sectionTitle("On the Claude plan (Sandbox — not billed)") +
        table(
          ["", "", ""],
          [
            ["Saved (API-rate value of the work)", "", `${money(sub.notionalCost)}${subDelta ? ` (${subDelta})` : ""}`],
            ["Sandbox sessions · people", "", `${num(sub.sessions ?? 0)} session(s) · ${num(sub.users ?? 0)} person(s)`],
            ["Calls", "", num(sub.requests)],
            ["Tokens", "", `${num(sub.outputTokens)} out · ${num(sub.inputTokens)} in · ${num(sub.cachedTokens)} cached`],
            ["Plan right now", "", planLine || "no reading yet"],
            ["Fell back to the API key (billed)", "", sub.apiFallback && sub.apiFallback.requests > 0 ? `${num(sub.apiFallback.requests)} call(s) · ${money(sub.apiFallback.cost)}` : "never"],
            ["Waited for the plan's limit", "", sub.rateLimitWaits > 0 ? `${num(sub.rateLimitWaits)} time(s) — consider an API key for busy periods` : "never"],
            ["Installed most (not in the image = candidates)", "", sub.topPackages && sub.topPackages.length ? sub.topPackages.map((t) => `${t.name} ×${t.uses}`).join(", ") : "nothing this week"],
          ],
        )
      : "";

  const usage =
    subscription +
    sectionTitle("Spend by person") +
    table(
      ["Person", "Requests", "Cost"],
      report.byUser.map((r) => [r.label, num(r.requests), money(r.cost)]),
    ) +
    sectionTitle("Spend by model") +
    table(
      ["Model", "Requests", "Cost"],
      report.byModel.map((r) => [r.label, num(r.requests), money(r.cost)]),
    );

  const errors =
    sectionTitle(`Errors (${num(report.errorTotal)} in total)`) +
    table(
      ["Error", "Area", "Count"],
      report.errors.map((e) => [e.message, e.category, num(e.count)]),
    );

  const health =
    sectionTitle("Health") +
    table(
      ["Check", "", "Result"],
      [
        ["Files ingested this week", "", num(report.health.ingestedFiles)],
        ["Waiting to be processed", "", num(report.health.pendingFiles)],
        ["Stuck mid-processing", "", num(report.health.stuckFiles)],
        ["Failed to process", "", num(report.health.failedFiles)],
        ...report.health.engines.map((e) => [e.name, "", e.ok ? `OK — ${e.detail}` : `UNREACHABLE — ${e.detail}`]),
      ],
    );

  const text =
    `${b.name} — weekly report, ${period}\n\n` +
    `${allWell ? "All clear." : `Needs a look: ${problems.join(" · ")}`}\n\n` +
    `Spend: ${money(report.spend.cost)} (${deltaNote})\n` +
    `Requests: ${report.spend.requests} from ${report.spend.activeUsers} user(s)\n` +
    `Tokens: ${report.spend.outputTokens} out, ${report.spend.inputTokens} in, ${report.spend.cachedTokens} cached\n\n` +
    (sub && sub.requests > 0
      ? `On the Claude plan (Sandbox, not billed): saved ${money(sub.notionalCost)}${subDelta ? ` (${subDelta})` : ""}, ${sub.requests} calls, ` +
        `${sub.sessions ?? 0} session(s) by ${sub.users ?? 0} person(s), ${sub.outputTokens} out / ${sub.inputTokens} in / ${sub.cachedTokens} cached, ` +
        `plan now: ${planLine || "no reading"}, fell back to the API key ${sub.apiFallback?.requests ?? 0} time(s) (${money(sub.apiFallback?.cost ?? 0)}), waited for the limit ${sub.rateLimitWaits} time(s)

`
      : "") +
    `By person:\n${report.byUser.map((r) => `  ${r.label}: ${money(r.cost)} (${r.requests})`).join("\n") || "  (none)"}\n\n` +
    `By model:\n${report.byModel.map((r) => `  ${r.label}: ${money(r.cost)} (${r.requests})`).join("\n") || "  (none)"}\n\n` +
    `Errors (${report.errorTotal}):\n${report.errors.map((e) => `  [${e.category}] ${e.message} ×${e.count}`).join("\n") || "  (none)"}\n\n` +
    `Health:\n` +
    `  ingested ${report.health.ingestedFiles}, pending ${report.health.pendingFiles}, stuck ${report.health.stuckFiles}, failed ${report.health.failedFiles}\n` +
    report.health.engines.map((e) => `  ${e.name}: ${e.ok ? "OK" : "UNREACHABLE"} (${e.detail})`).join("\n") +
    `\n\nUsage dashboard: ${appUrl("/admin/usage")}\n`;

  const testNote = "TEST SEND — sent by hand from Admin → SMTP. The numbers are this week's real ones so far; nothing is due.";
  const testBanner = opts.test
    ? `<div style="margin:0 0 16px;padding:12px 16px;border-radius:12px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:14px;font-weight:600;">${esc(testNote)}</div>`
    : "";
  return {
    subject: `${opts.test ? "[TEST] " : ""}[${b.name}] Weekly report — ${money(report.spend.cost)}${allWell ? "" : ", needs a look"}`,
    text: (opts.test ? `${testNote}

` : "") + text,
    html: reportShell(
      b,
      opts.test ? "Weekly report (TEST)" : "Weekly report",
      `${period} · costs in USD`,
      testBanner + banner + tiles + usage + errors + health,
    ),
  };
}

export async function newPasswordEmail(password: string, loginUrl: string): Promise<EmailContent> {
  const b = await brand();
  return {
    subject: `Your ${b.name} password was reset`,
    text: `An admin reset your ${b.name} password.\n\nYour new temporary password is:\n${password}\n\nSign in and change it: ${loginUrl}\n`,
    html: layout({
      brand: b,
      heading: "Your password was reset",
      paragraphs: [
        `An administrator has reset your <strong>${esc(b.name)}</strong> password. Use the temporary password below to sign in, then change it.`,
      ],
      callout: password,
      button: { label: "Sign in", url: loginUrl },
      note: "For your security, change this password after signing in.",
    }),
  };
}
