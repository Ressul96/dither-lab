// Lifecycle registry for tearing down long-lived listeners and observers
// when the app is closing, re-initializing, or under test. Single-window
// production builds rarely call disposeAll(), but the abstraction lets
// hot reload, multi-window, and unit tests reset the UI without leaking.
//
// Design constraints (CLAUDE.md "Surgical Changes"):
//   * Zero deps, no framework.
//   * Disposers run LIFO — last registered, first run — so observers
//     added on top of subscriptions tear down before the subscriptions.
//   * A failing disposer logs and continues; one bad cleanup must not
//     leave the rest pinned.

const disposables = [];

/**
 * Register a cleanup function to run when disposeAll() fires.
 * Returns an unregister handle so callers can also tear down early
 * (e.g. when a transient gizmo is removed before app shutdown).
 */
export function registerDispose(fn) {
  if (typeof fn !== "function") return () => {};
  disposables.push(fn);
  return () => {
    const index = disposables.indexOf(fn);
    if (index >= 0) disposables.splice(index, 1);
  };
}

/**
 * Run every registered disposer in LIFO order and clear the registry.
 * Safe to call multiple times — the second call is a no-op.
 */
export function disposeAll() {
  while (disposables.length) {
    const fn = disposables.pop();
    try {
      fn();
    } catch (error) {
      console.warn("[lifecycle] dispose failed", error);
    }
  }
}

/**
 * addEventListener wrapper that auto-registers a removeEventListener
 * disposer. Returns the unregister handle from registerDispose.
 *
 *   listenWithDispose(window, "resize", handler);
 *
 * is equivalent to:
 *
 *   window.addEventListener("resize", handler);
 *   registerDispose(() => window.removeEventListener("resize", handler));
 */
export function listenWithDispose(target, event, handler, options) {
  if (!target?.addEventListener) return () => {};
  target.addEventListener(event, handler, options);
  return registerDispose(() => {
    target.removeEventListener(event, handler, options);
  });
}

/**
 * Test/debug helper: how many disposers are currently registered.
 * Not exported for production use — only intended for sanity checks.
 */
export function _disposableCount() {
  return disposables.length;
}
