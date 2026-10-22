/**
 * The server's own rule for a usable code, mirrored so the page can decide
 * without asking again: inside its own window, active, with items left.
 *
 * `now` must be the anchored server time (see `clock.ts`), never the raw
 * browser clock — a laptop whose clock is wrong would otherwise keep an expired
 * code looking valid, or expire a live one early.
 */
export type CodeWindow = {
  status: string;
  code: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  maxItems: number;
};

export function usable(snapshot: CodeWindow, now: number): boolean {
  return snapshot.status === "ACTIVE" && Boolean(snapshot.code) && Boolean(snapshot.validFrom) &&
    Boolean(snapshot.expiresAt) && Date.parse(snapshot.validFrom!) <= now &&
    Date.parse(snapshot.expiresAt!) > now && snapshot.maxItems > 0;
}
