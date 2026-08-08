// @ts-check
import { PassThrough } from "node:stream";
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import "./utils/runs.mjs";
import { captureStdout } from "./utils/server.mjs";

// Policy: each split-sweep draw performs dozens of stream writes.
const STREAM_RUNS = 5;

const LINE = /event="test\.line"/g;
const PENDING = Symbol("pending");

/**
 * Whether `promise` is unresolved after the microtask queue and one macrotask drain. No sleep:
 * `setImmediate` runs after every I/O callback the stream could have queued.
 * @param {Promise<unknown>} promise
 */
async function stillPending(promise) {
  return (
    (await Promise.race([
      promise.then(() => "resolved"),
      new Promise((resolve) => setImmediate(() => resolve(PENDING))),
    ])) === PENDING
  );
}

/** @param {PassThrough} stream @param {string} text */
const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));

function reader() {
  const stdout = new PassThrough();
  return { stdout, logs: captureStdout(stdout) };
}

/** @param {number} n */
const matching = (n) => `event="test.line" n=${n}\n`;

const noise = fc.string().filter((s) => !s.includes('event="test.line"'));

test("waitForCount never resolves on traffic that does not match", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(noise, { minLength: 1, maxLength: 8 }), async (lines) => {
      const { stdout, logs } = reader();
      const waiting = logs.waitForCount(LINE, 1);
      for (const line of lines) await write(stdout, `${line}\n`);
      expect(await stillPending(waiting), JSON.stringify(lines)).toBe(true);
      expect(logs.count(LINE)).toBe(0);
      await write(stdout, matching(1));
      await expect(waiting).resolves.toBeUndefined();
    }),
  );
});

test("waitForCount waits for the Nth occurrence, at every arrival before it", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
      const { stdout, logs } = reader();
      const waiting = logs.waitForCount(LINE, n);
      for (let arrived = 1; arrived < n; arrived += 1) {
        await write(stdout, matching(arrived));
        expect(await stillPending(waiting), `${arrived} of ${n}`).toBe(true);
      }
      await write(stdout, matching(n));
      await expect(waiting).resolves.toBeUndefined();
      expect(logs.count(LINE)).toBe(n);
    }),
  );
});

test("a line is one line however its chunks fall", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 999 }), async (payload) => {
      const line = matching(payload);
      for (let split = 1; split < line.length; split += 1) {
        const { stdout, logs } = reader();
        const waiting = logs.waitForCount(LINE, 1);
        await write(stdout, line.slice(0, split));
        const matchedAlready = /event="test\.line"/.test(line.slice(0, split));
        expect(await stillPending(waiting), `split ${split}`).toBe(!matchedAlready);
        await write(stdout, line.slice(split));
        await expect(waiting).resolves.toBeUndefined();
        expect(logs.count(LINE), `split ${split}`).toBe(1);
      }
    }),
    { numRuns: STREAM_RUNS },
  );
});

test("a count the buffer already holds resolves without another chunk", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .integer({ min: 1, max: 8 })
        .chain((present) => fc.tuple(fc.constant(present), fc.integer({ min: 1, max: present }))),
      async ([present, wanted]) => {
        const { stdout, logs } = reader();
        for (let i = 1; i <= present; i += 1) await write(stdout, matching(i));
        await expect(logs.waitForCount(LINE, wanted)).resolves.toBeUndefined();
        expect(await stillPending(logs.waitForCount(LINE, present + 1))).toBe(true);
      },
    ),
  );
});

test("count and matches read the same buffer the waiter resolved on", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (kinds) => {
      const { stdout, logs } = reader();
      let written = 0;
      for (const [index, isMatch] of kinds.entries()) {
        await write(stdout, isMatch ? matching(index) : `event="other" n=${index}\n`);
        if (isMatch) written += 1;
      }
      if (written > 0) await logs.waitForCount(LINE, written);
      expect(logs.count(LINE)).toBe(written);
      expect(logs.matches(/n=(\d+)/g)).toHaveLength(kinds.length);
      expect(logs.count(/event="never\.emitted"/g)).toBe(0);
      expect(logs.matches(/event="never\.emitted"/g)).toEqual([]);
    }),
  );
});
