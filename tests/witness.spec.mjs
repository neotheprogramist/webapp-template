// @ts-check
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import "./utils/runs.mjs";
import {
  ALLOWED_STATUSES,
  FINDING_KINDS,
  isUnexplainedCancellation,
  judgeLoadingFailed,
  judgeLogEntry,
  judgeResponse,
  judgeSettledLoadingFailure,
  LOG_SOURCES_JUDGED_ELSEWHERE,
} from "./utils/witness-verdict.mjs";
import { CONTROLLED_KINDS, PURE_DRIVEN_KINDS } from "./utils/witness-controls.mjs";
import {
  decidedHeaders,
  expectCleanLayout,
  ROOT_STYLESHEET_LINK,
  expectNoEscapedPages,
  expectSecured,
  PER_RESPONSE_HEADERS,
  templatesDir,
  trackEscapedPages,
} from "./utils/server.mjs";
import { expectWebPageNode, parseJsonLd } from "./utils/schema.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** @param {{ kind: string }[]} findings */
const kindsOf = (findings) => findings.map((f) => f.kind).sort();

const host = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}\.test$/);
const path = fc.stringMatching(/^\/[a-z0-9/-]{0,20}$/);

/** @typedef {{ tag: "prefetch-failed", requestId: string }} PrefetchFailedEvent */
/** @typedef {{ tag: "loading-failed", requestId: string, loaderId: string, requestUrl: string, errorText: string, canceled: boolean, type: string }} LoadingFailedEvent */
/** @typedef {PrefetchFailedEvent | LoadingFailedEvent} FailureEvent */

test("the status verdict admits exactly the closed set, and nothing else", () => {
  fc.assert(
    fc.property(host, path, fc.integer({ min: 100, max: 599 }), (site, at, status) => {
      const url = `https://${site}${at}`;
      const documentURL = `https://${site}/`;
      for (const admitted of ALLOWED_STATUSES) {
        expect(judgeResponse({ url, documentURL, status: admitted }), `${admitted}`).toEqual([]);
      }
      fc.pre(!ALLOWED_STATUSES.has(status));
      expect(kindsOf(judgeResponse({ url, documentURL, status })), `${status}`).toEqual([
        "response-status",
      ]);
    }),
  );
});

test("the cross-origin verdict is decided by origin, not by URL text", () => {
  fc.assert(
    fc.property(host, host, path, fc.integer({ min: 1024, max: 65535 }), (a, b, at, port) => {
      fc.pre(a !== b);
      /** @type {[string, string, boolean][]} */
      const relations = [
        [`https://${a}${at}`, `https://${a}/`, false],
        [`https://${a}${at}`, `https://${a}/deep/page/`, false],
        [`https://${b}${at}`, `https://${a}/`, true],
        [`https://${a}${at}`, `https://${b}/`, true],
        [`http://${a}${at}`, `https://${a}/`, true],
        [`https://${a}:${port}${at}`, `https://${a}/`, true],
      ];
      for (const [url, documentURL, cross] of relations) {
        expect(
          kindsOf(judgeResponse({ url, documentURL, status: 200 })),
          `${url} from ${documentURL}`,
        ).toEqual(cross ? ["cross-origin"] : []);
      }
    }),
  );
});

test("the two response verdicts are independent", () => {
  fc.assert(
    fc.property(
      host,
      host,
      fc.integer({ min: 100, max: 599 }).filter((s) => !ALLOWED_STATUSES.has(s)),
      (a, b, status) => {
        fc.pre(a !== b);
        expect(
          kindsOf(judgeResponse({ url: `https://${b}/x`, documentURL: `https://${a}/`, status })),
        ).toEqual(["cross-origin", "response-status"]);
      },
    ),
  );
});

test("the log verdict skips exactly the sources another channel already judges", () => {
  fc.assert(
    fc.property(fc.string(), fc.stringMatching(/^[a-z]{3,8}$/), (message, level) => {
      for (const source of LOG_SOURCES_JUDGED_ELSEWHERE) {
        expect(judgeLogEntry({ source, level, text: message }), source).toBeNull();
      }
      for (const source of ["security", "deprecation", "rendering", "intervention", "other"]) {
        const judged = judgeLogEntry({ source, level, text: message });
        expect(judged?.kind, source).toBe("log-entry");
        expect(judged?.detail, source).toContain(source);
        expect(judged?.detail, source).toContain(level);
      }
    }),
  );
});

test("the loading-failed verdict returns one of exactly three outcomes, per shape", () => {
  fc.assert(
    fc.property(host, path, fc.stringMatching(/^net::ERR_[A-Z_]{3,20}$/), (site, at, errorText) => {
      const requestUrl = `https://${site}${at}`;
      /** @type {[Record<string, unknown>, string][]} */
      const shapes = [
        [{ canceled: true, type: "Ping" }, "excused"],
        [{ canceled: true, type: "Script" }, "defer"],
        [{ canceled: true, type: "Fetch" }, "defer"],
        [{ canceled: true, type: "Document" }, "finding"],
        [{ canceled: true, blockedReason: "csp", type: "Image" }, "finding"],
        [{ canceled: true, blockedReason: "csp", type: "Ping" }, "finding"],
        [{ canceled: false, type: "Script" }, "finding"],
        [{ type: "Script" }, "finding"],
      ];
      for (const [shape, outcome] of shapes) {
        const judged = judgeLoadingFailed({ requestUrl, errorText, ...shape });
        expect(judged.verdict, JSON.stringify(shape)).toBe(outcome);
        if (judged.verdict === "finding") {
          expect(judged.detail).toContain(requestUrl);
          expect(judged.detail).toContain(errorText);
          expect(judged.detail.includes("blocked:")).toBe("blockedReason" in shape);
        }
      }
    }),
  );
});

test("a deferred cancellation is a defect exactly when its document is still live", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (live, gone) => {
      fc.pre(live !== gone);
      expect(isUnexplainedCancellation({ loaderId: live, liveLoaderId: live })).toBe(true);
      expect(isUnexplainedCancellation({ loaderId: gone, liveLoaderId: live })).toBe(false);
    }),
  );
});

test("a failed prefetch owns its network terminal in either event order", () => {
  const requestId = "prefetch-request";
  /** @type {LoadingFailedEvent} */
  const loadingFailure = {
    tag: "loading-failed",
    requestId,
    loaderId: "live-loader",
    requestUrl: "https://a.test/missing",
    errorText: "net::ERR_ABORTED",
    canceled: true,
    type: "Prefetch",
  };
  /** @type {PrefetchFailedEvent} */
  const prefetchFailure = { tag: "prefetch-failed", requestId };
  /** @type {FailureEvent[][]} */
  const eventOrders = [
    [prefetchFailure, loadingFailure],
    [loadingFailure, prefetchFailure],
  ];
  for (const events of eventOrders) {
    const failedPrefetchRequestIds = new Set();
    /** @type {LoadingFailedEvent[]} */
    const loadingFailures = [];
    for (const event of events) {
      if (event.tag === "prefetch-failed") failedPrefetchRequestIds.add(event.requestId);
      else loadingFailures.push(event);
    }
    expect(
      loadingFailures
        .map((failure) =>
          judgeSettledLoadingFailure({
            ...failure,
            failedPrefetchRequestIds,
            liveLoaderId: "live-loader",
          }),
        )
        .filter(Boolean),
      events.map((event) => event.tag).join(" then "),
    ).toEqual([]);
  }
});

test("prefetch correlation preserves every independent loading failure", () => {
  const failedPrefetchRequestIds = new Set(["prefetch-request"]);
  const base = {
    failedPrefetchRequestIds,
    loaderId: "live-loader",
    liveLoaderId: "live-loader",
    requestUrl: "https://a.test/same-url",
    errorText: "net::ERR_ABORTED",
  };
  expect(
    judgeSettledLoadingFailure({ ...base, requestId: "prefetch-request", type: "Prefetch" }),
    "the matching request is owned by the prefetch finding",
  ).toBeNull();
  expect(
    judgeSettledLoadingFailure({ ...base, requestId: "another-request", type: "Prefetch" })?.kind,
    "the URL does not correlate two distinct requests",
  ).toBe("loading-failed");
  expect(
    judgeSettledLoadingFailure({
      ...base,
      requestId: "live-cancellation",
      canceled: true,
      type: "Fetch",
    })?.kind,
    "an unexplained cancellation in the live document remains a finding",
  ).toBe("loading-failed");
  expect(
    judgeSettledLoadingFailure({
      ...base,
      requestId: "departed-cancellation",
      loaderId: "departed-loader",
      canceled: true,
      type: "Fetch",
    }),
    "a cancellation belonging to the departed document remains excused",
  ).toBeNull();
  expect(
    judgeSettledLoadingFailure({
      ...base,
      requestId: "telemetry-cancellation",
      canceled: true,
      type: "Ping",
    }),
    "canceled telemetry remains excused",
  ).toBeNull();
});

const pureDrivers = {
  "response-status": () =>
    kindsOf(
      judgeResponse({ url: "https://a.test/x", documentURL: "https://a.test/", status: 500 }),
    ),
  "cross-origin": () =>
    kindsOf(
      judgeResponse({ url: "https://b.test/x", documentURL: "https://a.test/", status: 200 }),
    ),
  "loading-failed": () => {
    const judged = judgeLoadingFailed({ requestUrl: "https://a.test/x", errorText: "boom" });
    return judged.verdict === "finding" ? ["loading-failed"] : [];
  },
  "log-entry": () => {
    const judged = judgeLogEntry({ source: "security", level: "error", text: "boom" });
    return judged ? [judged.kind] : [];
  },
};

/**
 * How many assertions a witness makes, read from its own source. A control table is only exhaustive
 * if it has a row per assertion, and counting them in a comment is how that claim goes stale — the
 * same derivation `escapeRegExp`'s control does against its character class.
 * @param {Function} witness
 */
function assertionCount(witness) {
  const count = (witness.toString().match(/\bexpect\(/g) ?? []).length;
  expect(count, `${witness.name} makes assertions to control`).toBeGreaterThan(0);
  return count;
}

/** @type {[string, (html: string) => string][]} */
const layoutDefects = [
  ["an unrendered statement delimiter", (html) => html.replace("</body>", "{% block x %}</body>")],
  ["an unrendered expression delimiter", (html) => html.replace("</body>", "{{ title }}</body>")],
  ["a surviving HTML comment", (html) => html.replace("</body>", "<!-- note --></body>")],
  ["an escaped tag from markdown", (html) => html.replace("</body>", "&lt;div&gt;</body>")],
  ["no root stylesheet link", (html) => html.replace(ROOT_STYLESHEET_LINK, 'href="x"')],
  [
    "a speculation-rules block that is not the declared one",
    (html) =>
      html.replace(
        /<script type="speculationrules">.*?<\/script>/s,
        '<script type="speculationrules">{"prefetch":[]}</script>',
      ),
  ],
  [
    "no speculation-rules block at all",
    (html) => html.replace(/<script type="speculationrules">.*?<\/script>/s, ""),
  ],
  [
    "a speculation-rules block that is not JSON at all",
    (html) =>
      html.replace(
        /<script type="speculationrules">.*?<\/script>/s,
        '<script type="speculationrules">{"prefetch":[</script>',
      ),
  ],
];

test("expectCleanLayout rejects every defect class it claims to catch", async () => {
  const clean = await readFile(join(templatesDir, "index.html"), "utf8");
  expectCleanLayout(clean, "the built homepage");
  expect(layoutDefects.length, "one row per assertion the witness makes").toBe(
    assertionCount(expectCleanLayout),
  );
  for (const [name, corrupt] of layoutDefects) {
    const broken = corrupt(clean);
    expect(broken, `${name} is actually applied`).not.toBe(clean);
    expect(() => expectCleanLayout(broken, name), name).toThrow();
  }
});

test("expectSecured rejects a missing, extra, or weakened decided header", async () => {
  const reference = { "content-security-policy": "default-src 'self'", "x-decided": "yes" };
  const served = { ...reference, date: "whenever", "content-length": "42" };
  expectSecured(served, reference, "the reference response");

  const [firstName] = Object.keys(reference);
  /** @type {[string, Record<string, string>][]} */
  const defects = [
    ["a decided header is missing", Object.fromEntries(Object.entries(served).slice(1))],
    ["a decided header is extra", { ...served, "x-smuggled": "1" }],
    ["a decided header is weakened", { ...served, [firstName]: "default-src *" }],
  ];
  for (const [name, headers] of defects) {
    expect(() => expectSecured(headers, reference, name), name).toThrow();
  }
  for (const name of PER_RESPONSE_HEADERS) {
    expectSecured({ ...served, [name]: "anything" }, reference, `${name} is per-response`);
  }
  expect(
    Object.keys(decidedHeaders(served)).sort(),
    "decidedHeaders keeps exactly the decided set",
  ).toEqual(Object.keys(reference).sort());
});

test("expectWebPageNode rejects metadata that drifted off its page", async () => {
  const path = "/about/";
  const html = await readFile(join(templatesDir, "about/index.html"), "utf8");
  const node = parseJsonLd(html, path).find(
    (/** @type {{ "@type": string }} */ candidate) => candidate["@type"] === "WebPage",
  );
  expect(node, `${path} carries a WebPage`).toBeTruthy();
  expectWebPageNode(node, path, html);

  /** @type {[string, () => object][]} */
  const drifts = [
    ["@id names another page", () => ({ ...node, "@id": `${node["@id"]}x` })],
    ["url names another page", () => ({ ...node, url: `${node.url}x` })],
    ["the name is not the h1", () => ({ ...node, name: `${node.name} edited` })],
    [
      "the description is not the meta description",
      () => ({ ...node, description: `${node.description} edited` }),
    ],
    ["the page belongs to another site", () => ({ ...node, isPartOf: { "@id": "elsewhere" } })],
  ];
  expect(drifts.length, "one row per assertion the witness makes").toBe(
    assertionCount(expectWebPageNode),
  );
  for (const [name, drift] of drifts) {
    expect(() => expectWebPageNode(drift(), path, html), name).toThrow();
  }
});

test("the escaped-page check reports any page the fixture did not witness", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const escaped = trackEscapedPages(context);
    expectNoEscapedPages(escaped);
    const opened = context.waitForEvent("page");
    const extra = await context.newPage();
    await opened;
    expect(escaped, "the listener recorded the escaped page").toHaveLength(1);
    expect(() => expectNoEscapedPages(escaped)).toThrow();
    await extra.close();
  } finally {
    await context.close();
  }
});

test("every finding kind is driven by a control somewhere in the suite", () => {
  for (const [kind, drive] of Object.entries(pureDrivers)) {
    expect(drive(), `${kind} is produced by the verdict that claims it`).toEqual([kind]);
  }
  expect([...CONTROLLED_KINDS].sort()).toEqual([...FINDING_KINDS].sort());
  expect([...PURE_DRIVEN_KINDS].sort(), "the pure half is exactly what is driven above").toEqual(
    Object.keys(pureDrivers).sort(),
  );
});
