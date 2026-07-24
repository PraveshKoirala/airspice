/**
 * Service-worker registration (Milestone M6, issue #31).
 *
 * Registered only in a production build and only when the browser supports
 * service workers. In dev we deliberately do NOT register one — a caching SW
 * fighting Vite's HMR is a debugging trap. See public/sw.js for the strategy.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Registration failure must never break the app; offline is an enhancement.
      console.warn("[airspice] service worker registration failed:", err);
    });
  });
}
