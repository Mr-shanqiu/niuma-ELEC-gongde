import assert from "node:assert/strict";
import test from "node:test";

import { clockAnchor, clockAt, nextClockDelay, CLOCK_TICK_MS } from "../src/ui/clock.ts";
import { usable } from "../src/ui/code-window.ts";
import { parseClaimLink } from "../src/ui/claim-link.ts";

/**
 * The three rules the review found broken, checked as arithmetic rather than by
 * looking at a screen. Each test states the defect it would have caught.
 */

const snapshot = (overrides = {}) => ({
  status: "ACTIVE",
  code: "GD123456",
  validFrom: "2026-10-22T00:00:00.000Z",
  expiresAt: "2026-10-22T00:20:00.000Z",
  maxItems: 10,
  ...overrides
});

test("F3: the countdown advances with elapsed time instead of cancelling out", () => {
  // Server is 10 minutes behind the browser; that must not matter.
  const clientAtResponse = Date.parse("2026-10-22T00:09:50.000Z");
  const anchor = clockAnchor("2026-10-21T23:59:50.000Z", clientAtResponse);
  assert.ok(anchor);

  // Same instant as the response: ten minutes left.
  assert.equal(anchor.server + (clientAtResponse - anchor.client), Date.parse("2026-10-21T23:59:50.000Z"));

  // Two minutes later on the wall clock, the anchored server time moved by two
  // minutes as well. The old formula recomputed `serverTime - now` each render
  // and added it back to `now`, so this number never changed.
  const later = clientAtResponse + 120_000;
  assert.equal(clockAt(anchor, later), Date.parse("2026-10-22T00:01:50.000Z"));
  assert.notEqual(clockAt(anchor, later), clockAt(anchor, clientAtResponse));
});

test("F3: crossing the expiry boundary makes the code unusable and the copy disabled", () => {
  const clientAtResponse = Date.parse("2026-10-22T00:19:00.000Z");
  const anchor = clockAnchor("2026-10-22T00:19:00.000Z", clientAtResponse);
  assert.ok(anchor);
  const live = snapshot();

  // One minute before expiry: usable, one minute remaining.
  const before = clockAt(anchor, clientAtResponse + 0);
  assert.equal(usable(live, before), true);
  assert.equal(Math.ceil((Date.parse(live.expiresAt) - before) / 1000), 60);

  // Exactly at expiry the window is closed (the server uses `>` not `>=`).
  assert.equal(usable(live, clockAt(anchor, clientAtResponse + 60_000)), false);
  // And it stays closed afterwards.
  assert.equal(usable(live, clockAt(anchor, clientAtResponse + 600_000)), false);

  // A refreshed response re-anchors, so a renewed code is live again.
  const renewed = snapshot({ expiresAt: "2026-10-22T01:00:00.000Z" });
  const reanchored = clockAnchor("2026-10-22T00:20:05.000Z", clientAtResponse + 65_000);
  assert.ok(reanchored);
  assert.equal(usable(renewed, clockAt(reanchored, clientAtResponse + 65_000)), true);
});

test("F3: the clock wakes at the expiry boundary, not only on its regular tick", () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  // Nothing to wait for: the regular tick.
  assert.equal(nextClockDelay(now, null), CLOCK_TICK_MS);
  // Expiry is farther away than one tick: still the regular tick.
  assert.equal(nextClockDelay(now, now + 60_000), CLOCK_TICK_MS);
  // Expiry inside the next tick: wake just after it, so the comparison is past.
  const delay = nextClockDelay(now, now + 2_000);
  assert.ok(delay < 2_000 + 100, `wake must land on the boundary, got ${delay}`);
  assert.ok(delay >= 250, "but not in a busy loop");
  // Already expired: no special wake, the state is settled.
  assert.equal(nextClockDelay(now, now), CLOCK_TICK_MS);
  assert.equal(nextClockDelay(now, now - 1_000), CLOCK_TICK_MS);
});

test("F3: an unusable snapshot is not made usable by a missing anchor", () => {
  assert.equal(clockAnchor(null, Date.now()), null);
  assert.equal(clockAnchor("not-a-date", Date.now()), null);
  // The page uses -Infinity when nothing has been read, which must never pass.
  assert.equal(usable(snapshot(), Number.NEGATIVE_INFINITY), false);
  assert.equal(usable(snapshot({ status: "PAUSED" }), Date.parse("2026-10-22T00:05:00.000Z")), false);
  assert.equal(usable(snapshot({ code: null }), Date.parse("2026-10-22T00:05:00.000Z")), false);
  assert.equal(usable(snapshot({ maxItems: 0 }), Date.parse("2026-10-22T00:05:00.000Z")), false);
  assert.equal(usable(snapshot({ validFrom: null }), Date.parse("2026-10-22T00:05:00.000Z")), false);
});

test("F7: the issue-list deep link yields a day and a batch", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(parseClaimLink(`#/code?claimId=${id}&date=2026-10-21`), { claimId: id, date: "2026-10-21" });
  // Only one of the two is still useful.
  assert.deepEqual(parseClaimLink(`#/code?date=2026-10-21`), { claimId: null, date: "2026-10-21" });
  assert.deepEqual(parseClaimLink(`#/code?claimId=${id}`), { claimId: id, date: null });
  // No query at all is the normal day view, not an error.
  assert.deepEqual(parseClaimLink("#/code"), { claimId: null, date: null });
  assert.deepEqual(parseClaimLink(""), { claimId: null, date: null });
});

test("F7: a malformed link falls back to the day view instead of filtering on garbage", () => {
  assert.deepEqual(parseClaimLink("#/code?claimId=../../etc&date=2026-10-21"), { claimId: null, date: "2026-10-21" });
  assert.deepEqual(parseClaimLink("#/code?claimId=0123456789ABCDEF0123456789ABCDEF"), { claimId: null, date: null });
  assert.deepEqual(parseClaimLink("#/code?date=2026-13-45"), { claimId: null, date: null });
  assert.deepEqual(parseClaimLink("#/code?date=yesterday"), { claimId: null, date: null });
});
