// @ts-check
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import srcData from "../../web/src/src.11tydata.mjs";
import { attachClientWitness } from "./witness.mjs";

// PROOF: a socket address ends in a whole decimal port before the log line terminator.
const LISTEN_PORT = /event="server\.listen".*\baddr=\S*:(\d+)\b.*\n/;

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const templatesDir = join(repoRoot, "server/templates");

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptionsWithoutStdio} [options]
 */
function cargoRun(bin, args, options = {}) {
  const child = spawn(
    "cargo",
    ["run", "--release", "-p", "server", "--features", "self-signed", "--bin", bin, "--", ...args],
    { cwd: repoRoot, ...options },
  );
  // Register before returning so `exited` cannot miss process completion.
  settled.set(child, new Promise((resolve) => child.once("close", resolve)));
  return child;
}

/** @type {WeakMap<import('node:child_process').ChildProcess, Promise<number | null>>} */
const settled = new WeakMap();

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
export function exited(child) {
  const done = settled.get(child);
  if (!done) throw new Error("exited: child was not spawned by cargoRun");
  return done;
}

/** @type {WeakMap<import('node:child_process').ChildProcess, Promise<{ url: string } | { code: number | null }>>} */
const listenOutcomes = new WeakMap();

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
function observeListen(child) {
  listenOutcomes.set(
    child,
    new Promise((resolve) => {
      let buf = "";
      /** @param {Buffer} chunk */
      const onData = (chunk) => {
        buf += chunk.toString();
        const match = buf.match(LISTEN_PORT);
        if (!match) return;
        child.stdout.off("data", onData);
        resolve({ url: `https://[::1]:${match[1]}` });
      };
      child.stdout.on("data", onData);
      void exited(child).then((code) => {
        child.stdout.off("data", onData);
        resolve({ code });
      });
    }),
  );
}

export async function generateCertPair() {
  const dir = await mkdtemp(join(tmpdir(), "webapp-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const gen = cargoRun("certgen", ["--cert-path", certPath, "--key-path", keyPath]);
  const code = await exited(gen);
  if (code !== 0) throw new Error(`certgen exited with code ${code}`);
  return { dir, certPath, keyPath };
}

/** @param {string} dir */
export function removeCertDir(dir) {
  return rm(dir, { recursive: true, force: true });
}

/** @param {Record<string, string>} [env] */
export function spawnServer(env = {}) {
  const child = cargoRun("server", [], {
    detached: true,
    env: {
      ...process.env,
      ...env,
      APP_PORT: "0",
      APP_TEMPLATES_DIR: "server/templates",
      RUST_LOG: "info",
    },
  });
  observeListen(child);
  return child;
}

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
export function terminate(child) {
  // PROOF: the caller observed the child running (listen log or exit), so it spawned and has a pid.
  process.kill(-(/** @type {number} */ (child.pid)), "SIGTERM");
}

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
function terminateIfRunning(child) {
  try {
    terminate(child);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
  }
}

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
export async function waitForListen(child) {
  const outcome = listenOutcomes.get(child);
  if (!outcome) throw new Error("waitForListen: child was not spawned by spawnServer");
  const observed = await outcome;
  if ("url" in observed) return observed.url;
  throw new Error(`server exited before listening (code ${observed.code})`);
}

/** @param {import('node:stream').Readable} stdout */
export function captureStdout(stdout) {
  let buf = "";
  /** @type {(() => void)[]} */
  const listeners = [];
  stdout.on("data", (chunk) => {
    buf += chunk.toString();
    for (const notify of listeners.splice(0)) notify();
  });
  return {
    /** @param {RegExp} pattern */
    count: (pattern) => (buf.match(pattern) ?? []).length,
    /** @param {RegExp} pattern */
    matches: (pattern) => buf.match(pattern) ?? [],
    /** @param {RegExp} pattern @param {number} n */
    waitForCount: (pattern, n) =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          const check = () => {
            if ((buf.match(pattern) ?? []).length >= n) resolve();
            else listeners.push(check);
          };
          check();
        })
      ),
  };
}

/** @param {(server: { url: string, logs: ReturnType<typeof captureStdout>, certPath: string }) => Promise<void>} body */
export async function withCapturedServer(body) {
  const { dir, certPath, keyPath } = await generateCertPair();
  const child = spawnServer({ APP_TLS_CERT: certPath, APP_TLS_KEY: keyPath });
  const logs = captureStdout(child.stdout);
  /** @type {unknown} */
  let bodyFailure;
  try {
    const url = await waitForListen(child);
    await body({ url, logs, certPath });
  } catch (error) {
    bodyFailure = error;
  }

  /** @type {unknown} */
  let shutdownFailure;
  try {
    const gone = exited(child);
    terminateIfRunning(child);
    const code = await gone;
    if (code !== 0) shutdownFailure = new Error(`server did not exit gracefully (code ${code})`);
    if (logs.count(/event="server\.shutdown"/g) !== 1) {
      shutdownFailure ??= new Error("server did not log exactly one graceful shutdown event");
    }
  } catch (error) {
    shutdownFailure = error;
  }

  /** @type {unknown} */
  let cleanupFailure;
  try {
    await removeCertDir(dir);
  } catch (error) {
    cleanupFailure = error;
  }

  if (bodyFailure !== undefined) throw bodyFailure;
  if (shutdownFailure !== undefined) throw shutdownFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

/** @param {import('@playwright/test').BrowserContext} context */
export function trackEscapedPages(context) {
  /** @type {string[]} */
  const escaped = [];
  context.on("page", (extra) => escaped.push(extra.url()));
  return escaped;
}

/** @param {string[]} escaped */
export function expectNoEscapedPages(escaped) {
  expect(escaped, "every page in the context is the witnessed fixture page").toEqual([]);
}

const witnesses = new WeakMap();

/** @param {import('@playwright/test').Page} page */
export function witnessOf(page) {
  const witness = witnesses.get(page);
  if (!witness) throw new Error("witnessOf: page carries no client witness (not a fixture page)");
  return witness;
}

export const test = base.extend(
  /** @type {import('@playwright/test').Fixtures<{ page: import('@playwright/test').Page }, { serverURL: string }, import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions, import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions>} */ ({
    page: async ({ page }, use) => {
      const witness = await attachClientWitness(page);
      witnesses.set(page, witness);
      const escaped = trackEscapedPages(page.context());
      await use(page);
      await witness.settle();
      await witness.detach();
      expect(witness.findings(), "client witness: zero console/log/network defects").toEqual([]);
      expectNoEscapedPages(escaped);
    },
    serverURL: [
      // Playwright requires the first arg to be a destructuring pattern; this fixture needs none.
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await withCapturedServer(async ({ url }) => {
          await use(url);
        });
      },
      { scope: "worker" },
    ],
  }),
);

export const expect = test.expect;

// PROOF: these headers vary per response rather than expressing server policy.
export const PER_RESPONSE_HEADERS = new Set([
  "date",
  "content-length",
  "content-type",
  "content-encoding",
  "etag",
  "last-modified",
  "vary",
  "accept-ranges",
  "allow",
  "location",
  "transfer-encoding",
  "connection",
]);

// PROOF: Vite emits the root stylesheet with a content hash between this fixed prefix and suffix.
export const ROOT_STYLESHEET_LINK = /href="\/assets\/root-[^"]+\.css"/;

/** @param {Record<string, string>} headers */
export function decidedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !PER_RESPONSE_HEADERS.has(name)),
  );
}

/** @param {Record<string, string>} headers @param {Record<string, string>} reference @param {string} label */
export function expectSecured(headers, reference, label) {
  const decided = decidedHeaders(headers);
  expect(Object.keys(decided).sort(), `${label}: the decided header set`).toEqual(
    Object.keys(reference).sort(),
  );
  for (const [name, value] of Object.entries(reference)) {
    expect(decided[name], `${label}: ${name}`).toBe(value);
  }
}

/** @param {string} body @param {string} label */
export function expectCleanLayout(body, label) {
  expect(body, label).not.toContain("{%");
  expect(body, label).not.toContain("{{");
  expect(body, label).not.toContain("<!--");
  expect(body, `${label} renders no escaped HTML tag from markdown`).not.toMatch(/&lt;\/?[a-z]/);
  expect(body, label).toMatch(ROOT_STYLESHEET_LINK);
  const rules = body.match(/<script type="speculationrules">(.*?)<\/script>/s);
  expect(rules, `${label} carries the speculation-rules block`).not.toBeNull();
  const source = /** @type {RegExpMatchArray} */ (rules)[1];
  expect(() => JSON.parse(source), `${label}: the speculation rules are valid JSON`).not.toThrow();
  expect(JSON.parse(source), label).toEqual(srcData.speculationRules);
}
