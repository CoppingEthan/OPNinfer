"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listMyWorkflowsBrief, type WorkflowBrief } from "@/app/actions/workflows";

/**
 * The composer's `+` menu: attach a file, or pick one of your own workflows
 * to run this message through.
 *
 * Choosing one here is not a hint. The chat route loads that playbook and puts
 * it in the turn as an instruction, so the assistant follows it whether or not
 * it would have thought to — which is the point of choosing it by hand. The
 * per-turn WORKFLOWS list still exists for the times you don't.
 */

export interface PickedWorkflow {
  id: string;
  name: string;
}

export function ComposerMenu({
  disabled,
  onAttach,
  onPickWorkflow,
}: {
  disabled: boolean;
  onAttach: () => void;
  onPickWorkflow: (w: PickedWorkflow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowBrief[] | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetched when the menu opens, not on every render of the composer — a list
  // nobody has asked to see is not worth a query on each keystroke.
  useEffect(() => {
    if (!open || workflows) return;
    let live = true;
    listMyWorkflowsBrief().then((w) => live && setWorkflows(w));
    return () => {
      live = false;
    };
  }, [open, workflows]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setSubmenu(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSubmenu(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // Above the button: the composer sits at the bottom of the screen, so a
    // menu that dropped downwards would open off the edge.
    if (r) setAt({ x: r.left, y: r.top - 8 });
  };

  const show = () => {
    place();
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Attach a file or choose a workflow"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach a file or choose a workflow"
        data-composer-menu
        onClick={() => (open ? setOpen(false) : show())}
        // Hovering opens it too, after a beat — long enough that crossing the
        // button on the way to the text box does not fire it.
        onMouseEnter={() => {
          hoverTimer.current = setTimeout(show, 350);
        }}
        onMouseLeave={() => {
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
        }}
        disabled={disabled}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
      >
        <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M10 4.5v11M4.5 10h11" />
        </svg>
      </button>

      {open && at
        ? createPortal(
            <div
              role="menu"
              data-composer-menu-open
              style={{ left: at.x, top: at.y }}
              onMouseDown={(e) => e.stopPropagation()}
              className="fixed z-50 min-w-56 -translate-y-full rounded-xl border border-border bg-surface p-1 text-sm shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onAttach();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition-colors hover:bg-surface-hover"
              >
                <PaperclipIcon />
                Upload a file
              </button>

              <div
                onMouseEnter={() => setSubmenu(true)}
                className="relative"
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={submenu}
                  // Always OPEN, never toggle. Pointing at this row already
                  // opens the submenu, so a toggle meant that clicking the
                  // thing you were aiming at shut it again — it read as a
                  // flicker. Touch has no hover, so the click still has to
                  // open it; closing is Escape, or clicking away.
                  onClick={() => setSubmenu(true)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition-colors hover:bg-surface-hover"
                >
                  <WorkflowGlyph />
                  <span className="flex-1">Workflows</span>
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M6 3.5 10.5 8 6 12.5" />
                  </svg>
                </button>

                {submenu ? (
                  <div className="oi-scroll mt-0.5 max-h-64 overflow-y-auto border-t border-border pt-1">
                    {workflows === null ? (
                      <p className="px-2.5 py-2 text-xs text-muted">Loading…</p>
                    ) : workflows.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-muted">
                        None yet — make one from Workflows in the sidebar.
                      </p>
                    ) : (
                      workflows.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          role="menuitem"
                          data-workflow-option={w.id}
                          onClick={() => {
                            setOpen(false);
                            setSubmenu(false);
                            onPickWorkflow({ id: w.id, name: w.name });
                          }}
                          className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
                        >
                          <span className="truncate text-sm text-foreground">{w.name}</span>
                          <span className="truncate text-xs text-muted">{w.description}</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 9.2 9.8 13.9a3 3 0 0 1-4.2-4.2l5.2-5.2a2 2 0 0 1 2.8 2.8l-5.2 5.2a1 1 0 0 1-1.4-1.4l4.7-4.7" />
    </svg>
  );
}

function WorkflowGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.2 5.4 4.4 6.6 6.8 4.2M3.2 10.4 4.4 11.6 6.8 9.2M3.4 15.8h3.4M9.6 5.2h7.2M9.6 10.4h7.2M9.6 15.8h7.2" />
    </svg>
  );
}
