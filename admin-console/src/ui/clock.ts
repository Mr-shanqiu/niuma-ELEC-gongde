import { useEffect, useMemo, useState } from "react";

/**
 * Server time, held as an anchor.
 *
 * The earlier version computed `serverTime - now` on every render and then
 * added it back to `now`, which cancels out: the code stayed "live" forever and
 * the countdown never moved. The anchor is captured once per response and the
 * elapsed wall-clock time is added to it, so an expired code stops being
 * usable without waiting for a refresh.
 *
 * Kept as plain functions so the arithmetic can be checked without a browser.
 */
export type ClockAnchor = { server: number; client: number };

/** How often the page re-reads the clock while nothing is about to happen. */
export const CLOCK_TICK_MS = 15_000;

export function clockAnchor(serverTime: string | null, clientNow: number): ClockAnchor | null {
  const server = serverTime ? Date.parse(serverTime) : NaN;
  return Number.isFinite(server) ? { server, client: clientNow } : null;
}

/** The best estimate of server time at a later client moment. */
export function clockAt(anchor: ClockAnchor, clientNow: number): number {
  return anchor.server + (clientNow - anchor.client);
}

/**
 * When to look at the clock again.
 *
 * A fixed 15-second tick meant a code could stay "当前码有效" for up to fifteen
 * seconds after it expired, because nothing woke the page at the boundary. When
 * a deadline is closer than the regular tick, the next wake is scheduled for the
 * deadline itself (plus a small margin, so the comparison is already past it).
 */
export function nextClockDelay(now: number, deadline: number | null, tick = CLOCK_TICK_MS): number {
  if (deadline === null) return tick;
  const remaining = deadline - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return tick;
  return Math.min(tick, Math.max(250, remaining + 50));
}

export function useServerClock(serverTime: string | null, deadline: number | null = null) {
  const [tick, setTick] = useState(() => Date.now());
  // The client clock at the moment this response arrived is the second half of
  // the anchor; both are fixed together and only reset by a new response.
  const anchor = useMemo(() => clockAnchor(serverTime, Date.now()), [serverTime]);

  useEffect(() => {
    if (!anchor) return;
    let timer = 0;
    const wake = () => {
      const clientNow = Date.now();
      setTick(clientNow);
      timer = window.setTimeout(wake, nextClockDelay(clockAt(anchor, clientNow), deadline));
    };
    timer = window.setTimeout(wake, nextClockDelay(clockAt(anchor, Date.now()), deadline));
    return () => window.clearTimeout(timer);
  }, [anchor, deadline]);

  // A tick that predates the current anchor would place "now" before the
  // response's own serverTime, making an expired code look live again.
  const now = anchor ? clockAt(anchor, Math.max(tick, anchor.client)) : null;
  return { now, readAt: anchor?.server ?? null };
}
