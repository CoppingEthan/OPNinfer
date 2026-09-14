"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSystemPrompt } from "@/app/actions/assistant";
import { Button } from "@/components/ui/button";
import { fieldCls } from "./ui";

const PLACEHOLDER = `We're a Hertfordshire estate agency. Be concise and practical.

- Use British spelling and the £ sign.
- Never quote a property price or valuation — refer the user to a branch.
- If you're unsure about a policy, say so rather than guessing.`;

/**
 * Customise tab: the assistant's standing instructions. Sent as the first
 * system block on every user-facing turn (conversation, escalation and
 * failover) — this is what makes one instance behave like *that* client's
 * assistant rather than a generic one.
 */
export function SystemPromptForm({
  value: initialValue,
  maxChars,
}: {
  value: string;
  maxChars: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  // What's currently stored. Tracked in state rather than read from the prop:
  // `router.refresh()` doesn't necessarily re-render this component with the
  // new prop before the next edit, which left the baseline stale and the Save
  // button wrongly disabled on a second edit in the same visit.
  const [baseline, setBaseline] = useState(initialValue);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();

  const dirty = value !== baseline;
  const over = value.trim().length > maxChars;

  const save = () =>
    startTransition(async () => {
      setMsg({});
      const res = await saveSystemPrompt({ systemPrompt: value });
      setMsg(res);
      if (res.success) {
        setBaseline(value);
        router.refresh();
      }
    });

  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="system-prompt"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Assistant instructions
        </label>
        <textarea
          id="system-prompt"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={12}
          spellCheck
          placeholder={PLACEHOLDER}
          className={`${fieldCls} resize-y font-mono text-[13px] leading-relaxed`}
        />
        <div className="mt-1 flex items-start justify-between gap-4">
          <p className="text-xs text-muted">
            Standing instructions for every reply — who you are, what the
            business does, tone, and any house rules. The assistant is always
            told its own name, so you don&apos;t need to repeat it. Takes effect
            on the next message; no restart needed.
          </p>
          <span
            className={`shrink-0 text-xs tabular-nums ${
              over ? "text-red-600 dark:text-red-400" : "text-muted"
            }`}
          >
            {value.trim().length.toLocaleString()} / {maxChars.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || over || !dirty}>
          {pending ? "Saving…" : "Save instructions"}
        </Button>
        {dirty && !pending ? (
          <Button variant="ghost" onClick={() => setValue(baseline)}>
            Discard changes
          </Button>
        ) : null}
        {msg.error ? (
          <span className="text-sm text-red-600 dark:text-red-400">{msg.error}</span>
        ) : null}
        {msg.success ? (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            {msg.success}
          </span>
        ) : null}
      </div>
    </div>
  );
}
