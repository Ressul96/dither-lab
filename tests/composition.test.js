// Unit tests for the pure composition model (src/js/composition.js).
// Runs under node:test with zero build step: `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  addClip,
  addSource,
  compositionDuration,
  compositionFromSource,
  createDefaultComposition,
  isEmptyComposition,
  moveClip,
  normalizeComposition,
  removeClip,
  rippleDeleteClip,
  serializeComposition,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from "../src/js/composition.js";

// One-track / one-clip composition: source "src-1" (4s @ 30fps), clip-1 spans 0..4.
function fixture() {
  return compositionFromSource({
    loaded: true,
    path: "/tmp/fixture.mp4",
    duration: 4,
    sourceFps: 30,
    fps: 30,
    videoWidth: 640,
    videoHeight: 360,
  });
}

function clips(comp, trackId = "vt-1") {
  return comp.tracks.find((t) => t.id === trackId).clips;
}

test("createDefaultComposition is empty", () => {
  const comp = createDefaultComposition();
  assert.equal(isEmptyComposition(comp), true);
  assert.equal(compositionDuration(comp), 0);
});

test("compositionFromSource builds a single-clip composition spanning the source", () => {
  const comp = fixture();
  assert.equal(comp.sources.length, 1);
  assert.equal(comp.sources[0].id, "src-1");
  assert.equal(comp.tracks.length, 1);
  const [clip] = clips(comp);
  assert.equal(clip.start, 0);
  assert.equal(clip.duration, 4);
  assert.equal(clip.in, 0);
  assert.equal(clip.out, 4);
  assert.equal(compositionDuration(comp), 4);
  assert.equal(isEmptyComposition(comp), false);
});

test("addSource registers a source without creating clips", () => {
  const { composition, sourceId } = addSource(fixture(), {
    path: "/tmp/b.mp4",
    kind: "video",
    duration: 2,
    fps: 30,
    width: 320,
    height: 240,
    hasAudio: false,
  });
  assert.ok(sourceId);
  assert.equal(composition.sources.length, 2);
  assert.equal(clips(composition).length, 1); // unchanged
});

test("serialize -> normalize round-trips the model", () => {
  const comp = fixture();
  const roundTripped = normalizeComposition(serializeComposition(comp));
  assert.equal(roundTripped.sources.length, comp.sources.length);
  assert.equal(roundTripped.tracks.length, comp.tracks.length);
  assert.deepEqual(clips(roundTripped), clips(comp));
  assert.equal(roundTripped.duration, compositionDuration(comp));
});

test("addClip appends after the last clip on the track", () => {
  const comp = addClip(fixture(), { trackId: "vt-1", sourceId: "src-1", duration: 2 });
  const list = clips(comp);
  assert.equal(list.length, 2);
  assert.equal(list[1].start, 4); // appended after clip-1 (0..4)
  assert.equal(list[1].duration, 2);
  assert.equal(list[1].in, 0);
  assert.equal(list[1].out, 2);
});

test("addClip pushes an overlapping start to the first free slot", () => {
  const comp = addClip(fixture(), { trackId: "vt-1", sourceId: "src-1", start: 1, duration: 2 });
  const list = clips(comp);
  assert.equal(list.length, 2);
  // requested start 1 collides with clip-1 (0..4) → pushed to 4
  assert.equal(list[1].start, 4);
});

test("splitClip produces two clips playing the same frames across the cut", () => {
  const comp = splitClip(fixture(), { trackId: "vt-1", clipId: "clip-1", time: 2 });
  const [left, right] = clips(comp);
  assert.equal(left.duration, 2);
  assert.equal(left.out, 2);
  assert.equal(right.start, 2);
  assert.equal(right.duration, 2);
  assert.equal(right.in, 2);
  assert.equal(right.out, 4);
  assert.notEqual(left.id, right.id);
});

test("splitClip outside the clip interior is a no-op", () => {
  const base = fixture();
  assert.equal(splitClip(base, { trackId: "vt-1", clipId: "clip-1", time: 0 }), base);
  assert.equal(splitClip(base, { trackId: "vt-1", clipId: "clip-1", time: 4 }), base);
});

test("moveClip moves within free space and clamps against neighbours", () => {
  const split = splitClip(fixture(), { trackId: "vt-1", clipId: "clip-1", time: 2 });
  const rightId = clips(split)[1].id;
  // right clip (2..4) has free space after it: move to 3 works
  const moved = moveClip(split, { trackId: "vt-1", clipId: rightId, start: 3 });
  assert.equal(clips(moved)[1].start, 3);
  // left clip (0..2) is pinned between 0 and the right clip: move is clamped to 0 (identity)
  assert.equal(moveClip(split, { trackId: "vt-1", clipId: "clip-1", start: 1 }), split);
});

test("trimClipStart moves start and in-point together", () => {
  const comp = trimClipStart(fixture(), { trackId: "vt-1", clipId: "clip-1", start: 1 });
  const [clip] = clips(comp);
  assert.equal(clip.start, 1);
  assert.equal(clip.in, 1);
  assert.equal(clip.duration, 3);
});

test("trimClipEnd shortens duration and clamps to the source length", () => {
  const shortened = trimClipEnd(fixture(), { trackId: "vt-1", clipId: "clip-1", end: 2 });
  const [clip] = clips(shortened);
  assert.equal(clip.duration, 2);
  assert.equal(clip.out, 2);
  // extending past the source's 4s is clamped → nothing changes (identity)
  const base = fixture();
  assert.equal(trimClipEnd(base, { trackId: "vt-1", clipId: "clip-1", end: 10 }), base);
});

test("removeClip leaves a gap; rippleDeleteClip closes it", () => {
  const split = splitClip(fixture(), { trackId: "vt-1", clipId: "clip-1", time: 2 });
  const rightId = clips(split)[1].id;

  const gapped = removeClip(split, { trackId: "vt-1", clipId: "clip-1" });
  assert.equal(clips(gapped).length, 1);
  assert.equal(clips(gapped)[0].start, 2); // right clip stays put

  const rippled = rippleDeleteClip(split, { trackId: "vt-1", clipId: "clip-1" });
  assert.equal(clips(rippled).length, 1);
  assert.equal(clips(rippled)[0].id, rightId);
  assert.equal(clips(rippled)[0].start, 0); // pulled left by the removed duration
});
