// A throttled scheduler: request() runs fn at most once per intervalMs. The
// first request in a quiet period schedules a run; requests while a run is
// pending are coalesced. After a run fires, the next request schedules again.
// Pure and DOM-free so it is unit-testable with mock timers.

export function createThrottledScheduler(fn, intervalMs) {
  let timer = null;
  function request() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, intervalMs);
  }
  function cancel() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  return { request, cancel };
}
