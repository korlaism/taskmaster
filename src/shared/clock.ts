/**
 * All "current time" reads in application code go through a Clock, never a bare
 * `new Date()` / `Date.now()` call — this is what lets scheduler and metrics
 * tests pin a fake instant (including across a DST boundary) deterministically.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  return { now: () => fixed };
}
