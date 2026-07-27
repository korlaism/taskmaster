/**
 * Minimal IANA-timezone arithmetic used by the scheduler and metrics window
 * calculations. Deliberately dependency-free rather than pulling in luxon/date-fns-tz
 * for a V1 slice — revisit if DST edge cases (e.g. spring-forward gap times) prove
 * this insufficient; the DST-boundary unit tests in test/unit/timezone.test.ts are
 * the tripwire for that.
 */

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockInZone(instant: Date, timeZone: string): WallClockParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset in minutes such that (localWallClockMillis - offset*60000) === instant.getTime() */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const p = wallClockInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60000;
}

/** Converts a local wall-clock date+time in `timeZone` to the equivalent UTC instant. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!, hh!, mm!, 0));
  const offset1 = offsetMinutesAt(guess, timeZone);
  let utc = new Date(guess.getTime() - offset1 * 60000);
  const offset2 = offsetMinutesAt(utc, timeZone);
  if (offset2 !== offset1) {
    utc = new Date(guess.getTime() - offset2 * 60000);
  }
  return utc;
}

/** Returns 'YYYY-MM-DD' for the given instant, as observed in `timeZone`. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = wallClockInZone(instant, timeZone);
  return `${p.year.toString().padStart(4, "0")}-${p.month.toString().padStart(2, "0")}-${p.day
    .toString()
    .padStart(2, "0")}`;
}

export function isWeekend(instant: Date, timeZone: string): boolean {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const weekday = dtf.format(instant);
  return weekday === "Sat" || weekday === "Sun";
}
