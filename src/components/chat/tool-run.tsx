"use client";

import { useMemo, useState } from "react";
import Prism from "prismjs";
// Core bundles markup/css/clike/javascript; add the sandbox's usual suspects.
// (prism-typescript extends prism-javascript — import order matters.)
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-ruby";
import type { RunDiff, RunExec } from "@/lib/tool-run";

/**
 * Live tool-run block (sandbox family): while the model WRITES code the block
 * shows a rolling 5-line tail of the source as it streams in; when execution
 * starts it flips to a 5-line console tail; when the call finishes it
 * collapses into a compact chip row — filename, +N −M diff, duration ·
 * output lines · exit code — that expands on click to the full code/output.
 * Reloads render the collapsed state from the reply's meta.toolRuns.
 */
export interface ToolRunUI {
  id: string;
  tool: string;
  file?: string;
  command?: string;
  code: string;
  output: string;
  phase: "code" | "exec" | "done";
  diff?: RunDiff;
  exec?: RunExec;
  error?: string;
}

const TAIL_LINES = 5;

function tail(text: string, n = TAIL_LINES): string {
  if (!text) return "";
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

// --- syntax highlighting (VS-Code-style, Prism under the hood) ---------------

/** Filename extension → Prism grammar id. */
const EXT_LANG: Record<string, string> = {
  py: "python",
  sh: "bash", bash: "bash",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json",
  rb: "ruby",
  html: "markup", htm: "markup", xml: "markup", svg: "markup",
  css: "css",
};

/** Grammar for a run: commands are bash; files go by extension. */
function runLang(run: { tool: string; file?: string }): string | null {
  if (run.tool === "execute_command") return "bash";
  const ext = run.file?.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * An editor-pane code view: line-number gutter + Prism-highlighted source
 * (token colors in globals.css track the app theme, VS Code Light+/Dark+
 * palettes). Highlighting a 5-line tail per streamed delta is trivially
 * cheap, so the LIVE preview is highlighted too — code "types" in colour.
 */
function CodeView({
  code,
  lang,
  startLine = 1,
}: {
  code: string;
  lang: string | null;
  startLine?: number;
}) {
  const trimmed = code.replace(/\n+$/, "");
  const html = useMemo(() => {
    const grammar = lang ? Prism.languages[lang] : undefined;
    if (!grammar || !lang) return escapeHtml(trimmed);
    try {
      return Prism.highlight(trimmed, grammar, lang);
    } catch {
      return escapeHtml(trimmed);
    }
  }, [trimmed, lang]);
  const lineCount = trimmed ? trimmed.split("\n").length : 1;

  return (
    <div className="oi-code flex min-w-fit font-mono text-[11px] leading-4">
      <div
        aria-hidden="true"
        className="sticky left-0 shrink-0 select-none border-r border-border bg-surface px-2 text-right text-muted/50"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{startLine + i}</div>
        ))}
      </div>
      <pre className="whitespace-pre pl-3 pr-3" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function lineCount(text: string): number {
  const t = text.replace(/\n+$/, "");
  return t ? t.split("\n").length : 0;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 6000) / 10}m`;
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.max(0.01, Math.round(ms / 10) / 100)}s`;
}

function liveHeader(run: ToolRunUI): string {
  if (run.phase === "exec") {
    if (run.tool === "execute_command") return `Running: ${clip(run.command ?? "command", 60)}`;
    return `Running ${run.file ?? "the script"}`;
  }
  switch (run.tool) {
    case "edit_file":
      return run.file ? `Editing ${run.file}` : "Editing a file";
    case "execute_command":
      return "Writing a command";
    default:
      return run.file ? `Writing ${run.file}` : "Writing a file";
  }
}

/** What names the run once collapsed: the file, or the command, or the tool. */
function runName(run: ToolRunUI): string {
  if (run.file) return run.file;
  if (run.command ?? run.code) return clip((run.command ?? run.code).split("\n")[0], 48);
  return run.tool.replace(/_/g, " ");
}

function Spinner() {
  return (
    <span
      className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted border-t-transparent"
      aria-hidden="true"
    />
  );
}

function StatIcon({ failed }: { failed: boolean }) {
  return failed ? (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-muted/60" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** The compact stat cluster shared by the collapsed chip and expanded header. */
function RunStats({ run }: { run: ToolRunUI }) {
  return (
    <>
      {run.diff ? (
        <span className="flex items-center gap-1 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">+{run.diff.added}</span>
          {run.diff.removed > 0 ? (
            <span className="text-red-600 dark:text-red-400">−{run.diff.removed}</span>
          ) : null}
        </span>
      ) : null}
      {run.exec ? (
        <span className="whitespace-nowrap text-[11px] text-muted">
          {fmtDuration(run.exec.durationMs)} · {run.exec.lines} line{run.exec.lines === 1 ? "" : "s"}
          {run.exec.timedOut ? " · timed out" : run.exec.oomKilled ? " · out of memory" : run.exec.exitCode !== 0 ? ` · exit ${run.exec.exitCode}` : ""}
        </span>
      ) : null}
      {run.error ? (
        <span className="min-w-0 truncate text-[11px] text-red-600 dark:text-red-400">{clip(run.error, 80)}</span>
      ) : null}
    </>
  );
}

export function ToolRunBlock({ run }: { run: ToolRunUI }) {
  const [open, setOpen] = useState(false);
  const failed = !!run.error || (run.exec ? run.exec.exitCode !== 0 : false);

  if (run.phase !== "done") {
    // Live phase: header + a rolling 5-line tail — the code tail renders as
    // a highlighted editor pane, the console tail stays terminal-plain.
    const totalLines = lineCount(run.code);
    return (
      <div data-run={run.id} data-run-phase={run.phase} className="my-1.5 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
          <Spinner />
          <span className="oi-shimmer min-w-0 truncate text-muted">{liveHeader(run)}</span>
          {run.phase === "exec" && run.code ? (
            <span className="ml-auto whitespace-nowrap text-[11px] text-muted/70">
              {totalLines} lines written
            </span>
          ) : null}
        </div>
        {run.phase === "exec" ? (
          <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all border-t border-border px-3 py-1.5 font-mono text-[11px] leading-4 text-muted">
            {tail(run.output) || "…"}
          </pre>
        ) : run.code ? (
          <div className="max-h-24 overflow-hidden border-t border-border py-1.5">
            <CodeView
              code={tail(run.code)}
              lang={runLang(run)}
              startLine={Math.max(1, totalLines - TAIL_LINES + 1)}
            />
          </div>
        ) : (
          <pre className="border-t border-border px-3 py-1.5 font-mono text-[11px] leading-4 text-muted">…</pre>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        data-run={run.id}
        data-run-phase="done"
        onClick={() => setOpen(true)}
        className="my-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1 text-[12px] transition-colors hover:bg-surface-hover"
        title="Show the code and output"
      >
        <StatIcon failed={failed} />
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{runName(run)}</span>
        <RunStats run={run} />
        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-muted/60" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    );
  }

  return (
    <div data-run={run.id} data-run-phase="done" data-run-open className="my-1.5 max-w-full overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-hover"
        title="Collapse"
      >
        <StatIcon failed={failed} />
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{runName(run)}</span>
        <RunStats run={run} />
        <svg viewBox="0 0 24 24" className="ml-auto h-3 w-3 shrink-0 text-muted/60" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      {run.code ? (
        <div className="oi-scroll max-h-64 overflow-auto border-t border-border py-2">
          <CodeView code={run.code} lang={runLang(run)} />
        </div>
      ) : null}
      {run.output || run.command ? (
        <div className="border-t border-border">
          {run.command ? (
            <div className="truncate px-3 pt-2 font-mono text-[11px] text-muted">$ {run.command}</div>
          ) : null}
          <pre className="oi-scroll max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-4 text-muted">
            {run.output || "(no output)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
