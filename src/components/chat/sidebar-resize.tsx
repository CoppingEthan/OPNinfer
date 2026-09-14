"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared, persisted sidebar sizing for the chat + admin shells (spec: adjustable
 * and collapsible left panel). Both shells read the SAME localStorage keys, so
 * the admin panel always matches the width the user set on the chat panel.
 */
const WIDTH_KEY = "oi-sidebar-width";
const COLLAPSED_KEY = "oi-sidebar-collapsed";

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 440;
export const SIDEBAR_DEFAULT = 288;
export const SIDEBAR_RAIL = 64; // collapsed icon-rail width

export interface SidebarPrefs {
  width: number;
  setWidth: (w: number) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  toggleCollapsed: () => void;
  /** True once localStorage has been read (avoids a flash of the default). */
  loaded: boolean;
}

function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
}

export function useSidebarPrefs(): SidebarPrefs {
  const [width, setWidthState] = useState(SIDEBAR_DEFAULT);
  const [collapsed, setCollapsedState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(w) && w > 0) setWidthState(clampWidth(w));
    setCollapsedState(localStorage.getItem(COLLAPSED_KEY) === "1");
    setLoaded(true);
  }, []);

  // Re-sync across shells/tabs when the other panel changes the shared prefs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === WIDTH_KEY && e.newValue) setWidthState(clampWidth(Number(e.newValue)));
      if (e.key === COLLAPSED_KEY) setCollapsedState(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setWidth = useCallback(
    (w: number) => {
      const c = clampWidth(w);
      setWidthState(c);
      localStorage.setItem(WIDTH_KEY, String(c));
    },
    [],
  );

  const setCollapsed = useCallback((c: boolean) => {
    setCollapsedState(c);
    localStorage.setItem(COLLAPSED_KEY, c ? "1" : "0");
  }, []);

  const toggleCollapsed = useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  return { width, setWidth, collapsed, setCollapsed, toggleCollapsed, loaded };
}

/**
 * Draggable edge handle. Sits on the sidebar's right border; dragging resizes.
 * Double-click resets to the default width.
 */
export function ResizeHandle({
  width,
  setWidth,
}: {
  width: number;
  setWidth: (w: number) => void;
}) {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    // The sidebar's left edge is the viewport left (both shells), so the pointer
    // X is the width directly.
    setWidth(e.clientX);
  };

  const end = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title={`${Math.round(width)}px — drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
      className="group absolute right-0 top-0 z-30 hidden h-full w-1.5 translate-x-1/2 cursor-col-resize md:block"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent/60" />
    </div>
  );
}
