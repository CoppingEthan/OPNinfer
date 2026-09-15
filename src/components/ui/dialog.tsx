"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * In-app confirm and prompt.
 *
 * The browser's own `confirm()` and `prompt()` are the wrong thing in an app
 * like this: they are unstyled, they ignore dark mode, they cannot be tested
 * with Playwright without a dialog handler, they block the whole tab, and on a
 * phone they read as though the SITE is broken rather than asking a question.
 * They also say "localhost:3000 says" above your careful wording.
 *
 * The API is deliberately promise-shaped so the call sites read almost exactly
 * as they did before:
 *
 *     if (!(await dialog.confirm({ title: "Delete this chat?" }))) return;
 *     const name = await dialog.prompt({ title: "Rename", initial: old });
 *
 * `prompt` resolves to null when dismissed, like the browser's.
 */

interface ConfirmOptions {
  title: string;
  /** Optional second line. Keep it to the consequence, not a lecture. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button — for anything that destroys something. */
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  body?: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  maxLength?: number;
}

interface DialogApi {
  confirm(options: ConfirmOptions): Promise<boolean>;
  prompt(options: PromptOptions): Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

/**
 * Outside a provider the hook still works and falls back to the browser's
 * dialogs rather than throwing. A missing provider should never be the reason
 * a delete button silently does nothing.
 */
export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  return (
    ctx ?? {
      async confirm(o) {
        return typeof window === "undefined" ? false : window.confirm(o.title);
      },
      async prompt(o) {
        return typeof window === "undefined" ? null : window.prompt(o.title, o.initial ?? "");
      },
    }
  );
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (v: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => setPending({ kind: "confirm", options, resolve })),
      prompt: (options) =>
        new Promise<string | null>((resolve) => {
          setValue(options.initial ?? "");
          setPending({ kind: "prompt", options, resolve });
        }),
    }),
    [],
  );

  const settle = useCallback(
    (result: boolean | string | null) => {
      setPending((p) => {
        if (!p) return null;
        if (p.kind === "confirm") p.resolve(result === true);
        else p.resolve(typeof result === "string" ? result : null);
        return null;
      });
    },
    [],
  );

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(pending.kind === "confirm" ? false : null);
    };
    window.addEventListener("keydown", onKey);
    // Focus the input, or the confirm button, so Enter works without a click.
    const t = setTimeout(() => inputRef.current?.select(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [pending, settle]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={pending.options.title}
              data-app-dialog={pending.kind}
              onMouseDown={(e) => {
                // Dismiss on the backdrop only — not on a drag that ends there.
                if (e.target === e.currentTarget) settle(pending.kind === "confirm" ? false : null);
              }}
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
            >
              <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl">
                <h2 className="text-sm font-semibold text-foreground">{pending.options.title}</h2>
                {pending.options.body ? (
                  <p className="mt-1.5 text-sm text-muted">{pending.options.body}</p>
                ) : null}

                {pending.kind === "prompt" ? (
                  <form
                    className="mt-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = value.trim();
                      if (v) settle(v);
                    }}
                  >
                    {pending.options.label ? (
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                        {pending.options.label}
                      </label>
                    ) : null}
                    <input
                      ref={inputRef}
                      autoFocus
                      value={value}
                      maxLength={pending.options.maxLength ?? 120}
                      placeholder={pending.options.placeholder}
                      onChange={(e) => setValue(e.target.value)}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted"
                    />
                  </form>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    data-dialog-cancel
                    onClick={() => settle(pending.kind === "confirm" ? false : null)}
                    className="rounded-xl px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    {pending.kind === "confirm"
                      ? (pending.options.cancelLabel ?? "Cancel")
                      : "Cancel"}
                  </button>
                  <button
                    type="button"
                    data-dialog-confirm
                    autoFocus={pending.kind === "confirm"}
                    disabled={pending.kind === "prompt" && !value.trim()}
                    onClick={() => settle(pending.kind === "confirm" ? true : value.trim())}
                    className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 ${
                      pending.kind === "confirm" && pending.options.danger
                        ? "bg-red-600 text-white hover:bg-red-600/90"
                        : "bg-accent text-accent-foreground hover:opacity-90"
                    }`}
                  >
                    {pending.options.confirmLabel ??
                      (pending.kind === "confirm" ? "Confirm" : "Save")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </DialogContext.Provider>
  );
}
