// Minimal transient notification surface. One fixed host element, stacked
// toasts, auto-dismissed after a timeout or on click. The host is aria-live so
// screen readers announce failures without stealing focus.

let host = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.className = "toast-host";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

export function showToast(message, { kind = "info", timeoutMs = 5000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  ensureHost().appendChild(el);
  const timer = setTimeout(() => el.remove(), timeoutMs);
  el.addEventListener("click", () => {
    clearTimeout(timer);
    el.remove();
  });
  return el;
}

export function showErrorToast(message) {
  return showToast(message, { kind: "error", timeoutMs: 8000 });
}
