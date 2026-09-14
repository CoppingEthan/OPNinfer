"use client";

import { useActionState } from "react";
import { saveTokenLimits, type LimitsFormState } from "@/app/actions/admin";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";
import { Field, fieldCls } from "./ui";

export interface LimitDefaults {
  maxOutputTokens: number;
  maxInputTokens: number;
  maxToolRounds: number;
  compactAtTokens: number;
  compactKeepTokens: number;
}

/** Min/max per field, passed in from the server so these can't drift from
 *  what `saveTokenLimits` actually enforces. */
export type LimitFieldBounds = Record<
  keyof LimitDefaults,
  { readonly min: number; readonly max: number }
>;

/**
 * `step` is deliberately 1 on every field.
 *
 * A number input validates `(value - min) % step === 0`, so `min=1024
 * step=1024` silently rejected the DEFAULT 64,000 — the browser refused to
 * submit the form, offering 63,488 or 64,512 instead, and the Limits card
 * could not save its own defaults from v0.3.1 until 2026-08-03. A coarse step
 * buys nothing here (nobody nudges a token ceiling with the spinner arrows)
 * and quietly constrains which values are even expressible.
 */
const STEP = 1;

/**
 * Instance-wide per-turn ceilings. These apply to every provider, model and
 * reasoning setting — deliberately, because per-provider defaults are what
 * silently truncated real conversations mid-tool-call.
 */
export function LimitsForm({
  defaults,
  bounds,
}: {
  defaults: LimitDefaults;
  bounds: LimitFieldBounds;
}) {
  const [state, action] = useActionState<LimitsFormState, FormData>(saveTokenLimits, {});

  return (
    <form action={action} className="space-y-4">
      {state.error ? <FormMessage error={state.error} /> : null}
      {state.success ? <FormMessage success={state.success} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Max output tokens"
          hint="Ceiling on a single reply — thinking, tool calls and text combined. Too low and replies get cut off mid-sentence or mid-tool-call."
        >
          <input
            type="number"
            name="maxOutputTokens"
            min={bounds.maxOutputTokens.min}
            max={bounds.maxOutputTokens.max}
            step={STEP}
            defaultValue={defaults.maxOutputTokens}
            className={fieldCls}
          />
        </Field>
        <Field
          label="Max input tokens"
          hint="Hard ceiling on what a single reply may be sent. Past this, large tool results are trimmed away mid-reply. Keep it above the compaction trigger below."
        >
          <input
            type="number"
            name="maxInputTokens"
            min={bounds.maxInputTokens.min}
            max={bounds.maxInputTokens.max}
            step={STEP}
            defaultValue={defaults.maxInputTokens}
            className={fieldCls}
          />
        </Field>
        <Field
          label="Tool rounds per reply"
          hint="How many times the assistant may stop to use tools before it must answer. Rounds, not calls — one round can make several calls at once."
        >
          <input
            type="number"
            name="maxToolRounds"
            min={bounds.maxToolRounds.min}
            max={bounds.maxToolRounds.max}
            step={STEP}
            defaultValue={defaults.maxToolRounds}
            className={fieldCls}
          />
        </Field>
        <Field
          label="Compact conversations at"
          hint="Once a chat's history reaches this many tokens, the older part is summarised before the next reply, so long chats stay fast and cheap."
        >
          <input
            type="number"
            name="compactAtTokens"
            min={bounds.compactAtTokens.min}
            max={bounds.compactAtTokens.max}
            step={STEP}
            defaultValue={defaults.compactAtTokens}
            className={fieldCls}
          />
        </Field>
        <Field
          label="Keep recent"
          hint="How much of the most recent conversation (in tokens) is always sent word for word; only what comes before it is summarised. At most half of the trigger."
        >
          <input
            type="number"
            name="compactKeepTokens"
            min={bounds.compactKeepTokens.min}
            max={bounds.compactKeepTokens.max}
            step={STEP}
            defaultValue={defaults.compactKeepTokens}
            className={fieldCls}
          />
        </Field>
      </div>

      <p className="text-xs text-muted">
        These are ceilings, not reservations — you&rsquo;re billed for the tokens
        actually used. If a model can&rsquo;t emit as much as you ask for, the
        request is capped at whatever that model supports.
      </p>
      <p className="text-xs text-muted">
        Raise <strong>tool rounds</strong> if long jobs keep stopping to ask
        whether to continue; the first round is usually spent switching tools
        on, so the working budget is roughly one less than you set. Each extra
        round is another model call over the whole conversation so far, so it
        costs more — 10–15 suits research and multi-step file work, and the
        15-minute per-reply timeout is still the backstop.
      </p>
      <p className="text-xs text-muted">
        <strong>Compaction</strong> is what stops a long chat costing more with
        every message: past the trigger, the older messages are condensed into a
        summary by the front-end model (a few cents), and the reply model reads
        that plus the recent messages. People still see their whole chat; a thin
        line marks where the summary begins. Lower the trigger to save more per
        reply, raise it to keep more detail in view.
      </p>

      <SubmitButton pendingText="Saving…">Save limits</SubmitButton>
    </form>
  );
}
