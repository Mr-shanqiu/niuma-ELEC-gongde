export type DateRange = { start: string; end: string };
export const beijingDate = (now: Date) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(now);
const dayMs = 86400000;
export function rangeInstants(value: DateRange): { from: string; to: string } | null {
  const parse = (text: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
    const ms = Date.parse(`${text}T00:00:00+08:00`);
    return Number.isFinite(ms) && beijingDate(new Date(ms)) === text ? ms : NaN;
  };
  const from = parse(value.start), to = parse(value.end) + dayMs;
  if (![from,to].every(Number.isFinite) || to <= from || to-from > 366*dayMs) return null;
  return {from:new Date(from).toISOString(), to:new Date(to).toISOString()};
}
export function rangePreset(key: string, now = new Date()): DateRange {
  const today = beijingDate(now), ms = Date.parse(`${today}T00:00:00+08:00`);
  const date = (delta: number) => beijingDate(new Date(ms + delta*dayMs));
  const start = today.slice(0,8)+"01";
  if (key === "yesterday") return {start:date(-1),end:date(-1)};
  if (key === "7") return {start:date(-6),end:today};
  if (key === "30") return {start:date(-29),end:today};
  if (key === "month") return {start,end:today};
  if (key === "previousMonth") {
    const end = beijingDate(new Date(Date.parse(`${start}T00:00:00+08:00`)-dayMs));
    return {start:end.slice(0,8)+"01",end};
  }
  return {start:today,end:today};
}
export function rangeQuery(range: DateRange) {
  const instants=rangeInstants(range);
  return instants ? new URLSearchParams(instants).toString() : null;
}
