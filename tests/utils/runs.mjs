// @ts-check
import fc from "fast-check";

// Policy: default draw count for I/O-bound properties.
const DEFAULT_RUNS = 40;

export const runs = (() => {
  const raw = process.env.FC_NUM_RUNS;
  const parsed = Number(raw ?? DEFAULT_RUNS);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`FC_NUM_RUNS must be a positive integer, got ${raw}`);
  }
  return parsed;
})();

if (process.env.FC_NUM_RUNS) {
  fc.configureGlobal({ numRuns: runs });
}
