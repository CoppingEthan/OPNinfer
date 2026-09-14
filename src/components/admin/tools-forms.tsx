"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveToolGroups,
  saveTavilyKey,
  clearTavilyKey,
  saveImageQuotas,
  saveMemoryConfig,
  saveCapability,
} from "@/app/actions/tools";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { fieldCls } from "./ui";

/** Admin → Tools client forms (v0.3 step 10). */

type Msg = { error?: string; success?: string };

function useSave() {
  const router = useRouter();
  const [msg, setMsg] = useState<Msg>({});
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Msg>) => {
    setMsg({});
    start(async () => {
      const res = await fn();
      setMsg(res);
      if (res.success) router.refresh();
    });
  };
  return { msg, pending, run };
}

const Messages = ({ msg }: { msg: Msg }) => (
  <>
    {msg.error ? <FormMessage error={msg.error} /> : null}
    {msg.success ? <FormMessage success={msg.success} /> : null}
  </>
);

// --- tool groups -----------------------------------------------------------

const GROUP_LABELS: { id: string; label: string; blurb: string }[] = [
  { id: "files", label: "Chat files", blurb: "read/list the files uploaded to a chat" },
  { id: "web", label: "Web", blurb: "search, read pages, download files from the internet" },
  { id: "image", label: "Images", blurb: "view, generate, edit and blend images" },
  { id: "memory", label: "User memory", blurb: "remember facts about each user across chats" },
  { id: "visualize", label: "Visualisations", blurb: "draw charts and diagrams in the chat" },
  { id: "skills", label: "Skills", blurb: "load specialised task playbooks" },
  { id: "datetime", label: "Date & time", blurb: "current time and date arithmetic" },
  {
    id: "ask",
    label: "Clarifying questions",
    blurb: "pause a reply to ask the user a multiple-choice question",
  },
  { id: "capability", label: "Client capabilities", blurb: "the client-specific tools configured below" },
];

export function ToolGroupsForm({ disabled }: { disabled: string[] }) {
  const { msg, pending, run } = useSave();
  const [off, setOff] = useState(new Set(disabled));

  const toggle = (id: string) => {
    const next = new Set(off);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOff(next);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {GROUP_LABELS.map((g) => (
          <label
            key={g.id}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-surface-hover"
          >
            <input
              type="checkbox"
              checked={!off.has(g.id)}
              onChange={() => toggle(g.id)}
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{g.label}</span>
              <span className="block text-xs text-muted">{g.blurb}</span>
            </span>
          </label>
        ))}
      </div>
      <Messages msg={msg} />
      <Button onClick={() => run(() => saveToolGroups([...off]))} disabled={pending}>
        {pending ? "Saving…" : "Save tool availability"}
      </Button>
    </div>
  );
}

// --- Tavily key ---------------------------------------------------------------

export function TavilyKeyForm({ configured }: { configured: boolean }) {
  const { msg, pending, run } = useSave();
  const [key, setKey] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Powers web search, page reading, and search-and-read. Free tier at{" "}
        <span className="font-mono text-xs">tavily.com</span>. Stored encrypted.{" "}
        {configured ? (
          <span className="font-medium text-emerald-600 dark:text-emerald-400">Configured ✓</span>
        ) : (
          <span className="font-medium text-amber-600 dark:text-amber-400">Not configured</span>
        )}
      </p>
      <div className="flex max-w-md gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={configured ? "Replace key…" : "tvly-…"}
          className={fieldCls}
        />
        <Button
          onClick={() => run(async () => {
            const r = await saveTavilyKey(key);
            if (r.success) setKey("");
            return r;
          })}
          disabled={pending || !key.trim()}
        >
          {pending ? "Verifying…" : "Save"}
        </Button>
        {configured ? (
          <Button variant="ghost" onClick={() => run(() => clearTavilyKey())} disabled={pending}
            className="text-red-600 hover:bg-red-500/10 dark:text-red-400">
            Remove
          </Button>
        ) : null}
      </div>
      <Messages msg={msg} />
    </div>
  );
}

// --- image quotas ----------------------------------------------------------------

export function ImageQuotasForm({ flash, pro }: { flash: number; pro: number }) {
  const { msg, pending, run } = useSave();
  const [f, setF] = useState(flash);
  const [p, setP] = useState(pro);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Per-user image generations allowed in a rolling 7-day window (uses the Google key).
      </p>
      <div className="flex max-w-md gap-4">
        <label className="block flex-1">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Standard / week</span>
          <input type="number" min={0} value={f} onChange={(e) => setF(Number(e.target.value))} className={fieldCls} />
        </label>
        <label className="block flex-1">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Max quality / week</span>
          <input type="number" min={0} value={p} onChange={(e) => setP(Number(e.target.value))} className={fieldCls} />
        </label>
      </div>
      <Messages msg={msg} />
      <Button onClick={() => run(() => saveImageQuotas(f, p))} disabled={pending}>
        {pending ? "Saving…" : "Save quotas"}
      </Button>
    </div>
  );
}

// --- memory budget --------------------------------------------------------------

export function MemoryConfigForm({
  config,
}: {
  config: { paused: boolean; topicChars: number; chatSearch: boolean };
}) {
  const { msg, pending, run } = useSave();
  const [paused, setPaused] = useState(config.paused);
  const [chars, setChars] = useState(config.topicChars);
  const [chatSearch, setChatSearch] = useState(config.chatSearch);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        The assistant keeps four short notes about each person (who they are, how they like
        replies, their work, rules they&apos;ve given) and reads them in every chat. It fills
        them in itself once a chat has been quiet for 30 minutes, and people edit them in
        their own settings. Switch memory off altogether with the &ldquo;User memory&rdquo;
        group above.
      </p>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => setPaused(e.target.checked)}
          data-memory-admin-paused
          className="h-4 w-4 accent-accent"
        />
        <span className="text-sm text-foreground">
          Pause learning for everyone <span className="text-muted">— keeps what it knows, stops it saving anything new</span>
        </span>
      </label>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={chatSearch}
          onChange={(e) => setChatSearch(e.target.checked)}
          data-memory-admin-chat-search
          className="h-4 w-4 accent-accent"
        />
        <span className="text-sm text-foreground">
          Let the assistant search a person&apos;s own past chats <span className="text-muted">— &ldquo;what did we decide about…&rdquo;</span>
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Size of each note (characters)
        </span>
        <input
          type="number" min={200} max={8000} step={1} value={chars}
          onChange={(e) => setChars(Number(e.target.value))}
          className={`${fieldCls} max-w-[12rem]`}
        />
      </label>
      <Messages msg={msg} />
      <Button onClick={() => run(() => saveMemoryConfig({ paused, topicChars: chars, chatSearch }))} disabled={pending}>
        {pending ? "Saving…" : "Save memory settings"}
      </Button>
    </div>
  );
}

// --- capability card ---------------------------------------------------------------

export interface CapabilityView {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Optional "where the data comes from" line, declared by the capability
   *  itself rather than by the Tools page. */
  source?: { label: string; value: string };
}

/**
 * A capability with nothing to configure: just the switch, plus a read-only
 * line naming where the data comes from so an admin can see it without being
 * able to break it. That source is fixed in the capability's own code — a
 * different data provider would be a different platform, so it would be a new
 * capability rather than a URL typed in here.
 */
export function CapabilityToggleCard({
  cap,
  source,
}: {
  cap: CapabilityView;
  source?: { label: string; value: string };
}) {
  const { msg, pending, run } = useSave();
  const [enabled, setEnabled] = useState(cap.enabled);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        <span className="text-sm font-medium text-foreground">Enable for this workspace</span>
      </label>
      {source ? (
        <p className="text-xs text-muted">
          {source.label}: <span className="font-mono text-foreground">{source.value}</span>
        </p>
      ) : null}
      <Messages msg={msg} />
      <Button onClick={() => run(() => saveCapability(cap.id, enabled, {}))} disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
