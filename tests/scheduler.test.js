import test from "node:test";
import assert from "node:assert/strict";
import { createThrottledScheduler } from "../src/js/scheduler.js";

test("runs fn once per interval, coalescing requests", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const s = createThrottledScheduler(() => calls++, 100);
  s.request();
  s.request();
  s.request();
  assert.equal(calls, 0);
  t.mock.timers.tick(99);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1); // three requests coalesced into one run
});

test("a request after a run schedules a fresh run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const s = createThrottledScheduler(() => calls++, 100);
  s.request();
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  s.request();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
});

test("cancel stops a pending run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const s = createThrottledScheduler(() => calls++, 100);
  s.request();
  s.cancel();
  t.mock.timers.tick(200);
  assert.equal(calls, 0);
});
