/**
 * A link from today's issue list to one claim batch.
 *
 * `#/code?claimId=…&date=…` — both parts are optional and both are validated
 * here, because a malformed one must fall back to "the day view", not become a
 * filter the server cannot match. Pure, so the parsing is testable without a
 * router.
 */
export type ClaimLink = { claimId: string | null; date: string | null };

export function parseClaimLink(hash: string): ClaimLink {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  const claimId = query.get("claimId");
  const date = query.get("date");
  return {
    claimId: claimId && /^[a-f0-9]{32}$/u.test(claimId) ? claimId : null,
    // A date that is not a calendar date would make the server's range invalid;
    // rejecting it here keeps the page on the day view instead of erroring.
    date: date && /^\d{4}-\d{2}-\d{2}$/u.test(date) && !Number.isNaN(Date.parse(date)) ? date : null
  };
}
