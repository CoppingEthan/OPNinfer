"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js), which exists so the app can be
 * INSTALLED to a phone's home screen — Chrome will not offer that without a
 * worker carrying a fetch handler — and so a navigation made with no signal
 * shows our own "you're offline" page rather than the browser's error.
 *
 * Renders nothing, and fails quietly by design. Service workers need a secure
 * context, exactly like the microphone and crypto.randomUUID (see the
 * secure-context note in CLAUDE.md): over a plain-HTTP LAN address
 * `navigator.serviceWorker` is simply undefined, which is a perfectly normal
 * state for dev on another machine and not something to shout about.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // After load: registration competes with the app's own first requests for
    // the connection otherwise, and nothing here is needed to render a page.
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        console.debug("[pwa] service worker not registered:", err);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
