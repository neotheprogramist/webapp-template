// @ts-check
import { glob, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import fc from "fast-check";
import { runs } from "./utils/runs.mjs";
import {
  decidedHeaders,
  expect,
  expectCleanLayout,
  expectSecured,
  repoRoot,
  templatesDir,
  test,
  withCapturedServer,
} from "./utils/server.mjs";
import { robotsDirective, treePathOf, urlPathOf, withoutTrailingSlash } from "./utils/patterns.mjs";
import { expectWebPageNode, parseJsonLd } from "./utils/schema.mjs";
import srcData from "../web/src/src.11tydata.mjs";

const ERROR_PATH = "/404/";
const VERSION_PATH = "/version";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// Policy: each draw performs real browser or network I/O.
const HTTP_LAW_RUNS = 12;
const VIEWPORT_RUNS = 3;

// PROOF: llms.txt emits one Markdown link in this exact generated form per crawlable page.
const LLMS_PAGE_LINK = /^- \[[^\]]+\]\((https:\/\/[^)]+)\): /gm;

/** @template T @param {() => Promise<T>} produce */
function once(produce) {
  /** @type {Promise<T> | undefined} */
  let value;
  return () => (value ??= produce());
}

const builtPages = once(async () => {
  const pages = (await Array.fromAsync(glob("**/index.html", { cwd: templatesDir })))
    .map(urlPathOf)
    .sort();
  expect(pages.length, "the build emits pages").toBeGreaterThan(0);
  return pages;
});

const builtAssets = once(async () => {
  const assets = (await Array.fromAsync(glob("assets/**/*.*", { cwd: templatesDir })))
    .map((path) => `/${path}`)
    .sort();
  expect(assets.length, "the build emits assets").toBeGreaterThan(0);
  return assets;
});

/** @param {import("@playwright/test").Page} page @param {import("@playwright/test").APIRequestContext} request @param {string} serverURL */
async function crawl(page, request, serverURL) {
  const seen = new Set(["/"]);
  const pending = ["/"];
  const assets = new Set();
  while (pending.length > 0) {
    const path = pending.shift();
    // PROOF: the loop condition establishes that the queue contains one path.
    const response = await page.goto(serverURL + /** @type {string} */ (path));
    expect(response?.status(), String(path)).toBe(200);
    const hrefs = await page.$$eval('a[href^="/"]', (links) =>
      links.map((link) => link.getAttribute("href")),
    );
    for (const href of hrefs) {
      if (!href || href.includes("#") || seen.has(href)) continue;
      seen.add(href);
      pending.push(href);
    }
    for (const href of await page.$$eval('link[rel="stylesheet"]', (links) =>
      links.map((link) => link.getAttribute("href")),
    )) {
      if (href) assets.add(href);
    }
    for (const src of await page.$$eval('script[type="module"][src]', (scripts) =>
      scripts.map((script) => script.getAttribute("src")),
    )) {
      if (src) assets.add(src);
    }
    for (const resource of await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => new URL(entry.name).pathname)
        .filter((path) => path.startsWith("/assets/")),
    )) {
      assets.add(resource);
    }
  }
  const errorDocument = await (await request.get(serverURL + ERROR_PATH)).text();
  const errorStyles = await page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, "text/html");
    return [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) =>
      link.getAttribute("href"),
    );
  }, errorDocument);
  for (const href of errorStyles) {
    if (href) assets.add(href);
  }
  return { pages: [...seen].sort(), assets: [...assets].sort() };
}

/** @param {import("@playwright/test").APIRequestContext} request @param {string} serverURL */
async function securityReference(request, serverURL) {
  const reference = decidedHeaders((await request.get(serverURL + "/")).headers());
  expect(Object.keys(reference).length, "security policy is declared").toBeGreaterThan(0);
  return reference;
}

test.describe("generic site", () => {
  test("one renderer owns the Markdown autoescape bypass", async () => {
    const includesRoot = join(repoRoot, "web/src/_includes");
    const templates = await Array.fromAsync(glob("**/*.njk", { cwd: includesRoot }));
    const owners = [];
    for (const template of templates) {
      const source = await readFile(join(includesRoot, template), "utf8");
      if (/\bcontent\s*\|\s*safe\b/.test(source)) owners.push(template);
    }
    expect(owners.sort()).toEqual(["render.njk"]);
  });

  test("the internal-link closure equals the crawlable built page set", async ({
    page,
    request,
    serverURL,
  }) => {
    const observed = await crawl(page, request, serverURL);
    const expected = (await builtPages()).filter((path) => path !== ERROR_PATH);
    expect(observed.pages).toEqual(expected);
    expect(observed.assets).toEqual(await builtAssets());
  });

  test("every page is served byte-identically with coherent metadata", async ({
    request,
    serverURL,
  }) => {
    for (const path of await builtPages()) {
      const response = await request.get(serverURL + path);
      expect(response.status(), path).toBe(200);
      const built = await readFile(join(templatesDir, treePathOf(path), "index.html"));
      expect(await response.body(), path).toEqual(built);
      const html = built.toString();
      expectCleanLayout(html, path);
      expect(html, `${path}: canonical`).toContain(
        `<link rel="canonical" href="${srcData.site.url}${path}"`,
      );
      expect(html, `${path}: feed discovery`).toContain(
        `<link rel="alternate" type="application/rss+xml" title="${srcData.site.name} feed" href="/feed.xml"`,
      );
      const nodes = /** @type {Record<string, any>[]} */ (parseJsonLd(html, path));
      const pageNode = nodes.find((node) => node["@type"] === "WebPage");
      expect(pageNode, `${path}: carries a WebPage`).toBeTruthy();
      expectWebPageNode(pageNode, path, html);
      const websites = nodes.filter((node) => node["@type"] === "WebSite");
      if (path === "/") {
        expect(websites).toEqual([
          {
            "@type": "WebSite",
            "@id": srcData.site.url + "/#website",
            name: srcData.site.name,
            description: srcData.site.description,
            url: srcData.site.url + "/",
          },
        ]);
      } else {
        expect(websites, `${path}: does not redefine the site`).toEqual([]);
      }
      if (path === ERROR_PATH) {
        expect(html, `${path}: directly served error document is not indexable`).toContain(
          '<meta name="robots" content="noindex">',
        );
      }
    }
  });

  test("every public passthrough file ships at the root verbatim", async ({
    request,
    serverURL,
  }) => {
    const publicRoot = join(repoRoot, "web/public");
    const entries = await Array.fromAsync(glob("**/*", { cwd: publicRoot, withFileTypes: true }));
    const publicFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(publicRoot, join(entry.parentPath, entry.name)));
    expect(publicFiles.length, "web/public carries passthrough files").toBeGreaterThan(0);
    for (const name of publicFiles) {
      const response = await request.get(`${serverURL}/${name}`);
      expect(response.status(), name).toBe(200);
      const source = await readFile(join(publicRoot, name));
      expect(await response.body(), `${name}: served verbatim`).toEqual(source);
      expect(
        source.includes(Buffer.from("/assets/")),
        `${name}: verbatim files cannot name Vite's hashed namespace`,
      ).toBe(false);
    }
  });

  test("unknown paths use the fixed built 404 body", async ({ request, serverURL }) => {
    const expected = await readFile(join(templatesDir, "404/index.html"));
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const path = `/${id}/`;
        const missing = await request.get(serverURL + path);
        expect(missing.status(), path).toBe(404);
        expect(await missing.body(), path).toEqual(expected);
        expect(missing.headers()["content-type"], path).toContain("text/html");
        /** @type {Record<string, string>[]} */
        const conditionalHeaders = [
          { "if-modified-since": new Date().toUTCString() },
          { range: "bytes=0-9" },
        ];
        for (const headers of conditionalHeaders) {
          const replay = await request.get(serverURL + path, { headers });
          const label = `${path} with ${Object.keys(headers)[0]}`;
          expect(replay.status(), label).toBe(404);
          expect(replay.headers()["content-range"], label).toBeUndefined();
          expect(await replay.body(), label).toEqual(expected);
        }
      }),
      { numRuns: Math.min(runs, HTTP_LAW_RUNS) },
    );
  });

  test("the route and method grid carries one uniform security policy", async ({
    request,
    serverURL,
  }) => {
    const reference = await securityReference(request, serverURL);
    const paths = [...(await builtPages()), VERSION_PATH, "/not-a-real-page/"];
    for (const path of paths) {
      const oracle = await request.fetch(serverURL + path, { method: "OPTIONS", maxRedirects: 0 });
      expect(oracle.status(), `OPTIONS ${path}`).toBe(405);
      const served = String(oracle.headers()["allow"])
        .split(",")
        .map((method) => method.trim())
        .sort();
      expect(served.length, `${path}: non-empty Allow`).toBeGreaterThan(0);
      for (const method of HTTP_METHODS) {
        const response = await request.fetch(serverURL + path, { method, maxRedirects: 0 });
        expectSecured(response.headers(), reference, `${method} ${path}`);
        if (served.includes(method)) {
          expect(response.status(), `${method} ${path}`).not.toBe(405);
          expect(response.headers()["allow"], `${method} ${path}`).toBeUndefined();
        } else {
          expect(response.status(), `${method} ${path}`).toBe(405);
          expect(
            String(response.headers()["allow"])
              .split(",")
              .map((name) => name.trim())
              .sort(),
          ).toEqual(served);
        }
      }
    }
  });

  test("version reports the binary package version", async ({ request, serverURL }) => {
    const response = await request.get(serverURL + VERSION_PATH);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ version: "0.1.0" });
  });

  test("every built asset is referenced and served with its built bytes", async ({
    page,
    request,
    serverURL,
  }) => {
    const observed = await crawl(page, request, serverURL);
    for (const asset of await builtAssets()) {
      expect(observed.assets, `${asset}: referenced`).toContain(asset);
      const response = await request.get(serverURL + asset);
      expect(response.status(), asset).toBe(200);
      expect(await response.body(), asset).toEqual(
        await readFile(join(templatesDir, treePathOf(asset))),
      );
    }
  });

  test("sitemap and robots derive from the crawlable page set", async ({ request, serverURL }) => {
    const sitemap = await request.get(serverURL + "/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const locations = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1].replace(srcData.site.url, ""))
      .sort();
    expect(locations).toEqual((await builtPages()).filter((path) => path !== ERROR_PATH));

    const robots = await request.get(serverURL + "/robots.txt");
    expect(robots.status()).toBe(200);
    const body = await robots.text();
    expect(robotsDirective("User-agent", "*").test(body)).toBe(true);
    expect(robotsDirective("Allow", "/").test(body)).toBe(true);
    expect(robotsDirective("Sitemap", srcData.site.url + "/sitemap.xml").test(body)).toBe(true);
  });

  test("feed and llms discovery derive from the crawlable page set", async ({
    page,
    request,
    serverURL,
  }) => {
    const expected = (await builtPages())
      .filter((path) => path !== ERROR_PATH)
      .map((path) => srcData.site.url + path)
      .sort();

    const feed = await request.get(serverURL + "/feed.xml");
    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"]).toContain("xml");
    const feedURLs = await page.evaluate(
      (source) => {
        const document = new DOMParser().parseFromString(source, "application/xml");
        const error = document.querySelector("parsererror");
        if (error) throw new Error(error.textContent || "invalid feed XML");
        return [...document.querySelectorAll("item > link")].map((link) => link.textContent);
      },
      await feed.text(),
    );
    expect(feedURLs.sort()).toEqual(expected);

    const llms = await request.get(serverURL + "/llms.txt");
    expect(llms.status()).toBe(200);
    expect(llms.headers()["content-type"]).toContain("text/plain");
    const llmsURLs = [...(await llms.text()).matchAll(LLMS_PAGE_LINK)]
      .map((match) => match[1])
      .sort();
    expect(llmsURLs).toEqual(expected);
  });

  test("directory URLs canonicalize with one redirect", async ({ request, serverURL }) => {
    for (const path of (await builtPages()).filter((page) => page !== "/")) {
      const response = await request.get(serverURL + withoutTrailingSlash(path), {
        maxRedirects: 0,
      });
      expect([301, 307, 308], path).toContain(response.status());
      expect(response.headers()["location"], path).toBe(path);
    }
  });

  test("however a request target is spelled, redirects stay on-origin and terminate", async ({
    request,
    serverURL,
  }) => {
    const pages = (await builtPages()).filter((path) => path !== "/");
    /** @type {((path: string) => string)[]} */
    const mutations = [
      (path) => withoutTrailingSlash(path),
      (path) => `${path}?q=1&r=2`,
      (path) => `${withoutTrailingSlash(path)}?q=1`,
      (path) => path.replace(/\/$/, "//"),
      (path) => `/${path}`,
      (path) => path.replace(/\/([^/]+)\//, "/$1/./"),
      (path) => path.replace(/\/([^/]+)\//, "/$1/../$1/"),
      (path) => path.replace(/^\/([a-z])/, (_, character) => `/${character.toUpperCase()}`),
      (path) =>
        path.replace(/^\/([a-z])/, (_, character) => `/%${character.charCodeAt(0).toString(16)}`),
    ];
    for (const path of pages) {
      for (const mutate of mutations) {
        const target = mutate(path);
        const response = await request.get(serverURL + target, { maxRedirects: 0 });
        expect([200, 301, 302, 303, 307, 308, 404], target).toContain(response.status());
        const location = response.headers()["location"];
        if (location === undefined) continue;
        expect(location, `${target}: path-absolute redirect`).toMatch(/^\/(?!\/)/);
        expect(new URL(location, serverURL).origin, `${target}: same-origin redirect`).toBe(
          new URL(serverURL).origin,
        );
        const followed = await request.get(new URL(location, serverURL).toString(), {
          maxRedirects: 0,
        });
        expect(followed.headers()["location"], `${target}: redirect terminates`).toBeUndefined();
      }
    }
  });

  test("pages revalidate and negotiate supported compression", async ({ request, serverURL }) => {
    for (const path of await builtPages()) {
      if (path === ERROR_PATH) continue;
      const identity = await request.get(serverURL + path, {
        headers: { "accept-encoding": "identity" },
      });
      expect(
        identity.headers()["content-encoding"],
        `${path}: identity is not compressed`,
      ).toBeUndefined();
      const modified = identity.headers()["last-modified"];
      expect(modified, path).toMatch(/GMT$/);
      const replay = await request.get(serverURL + path, {
        headers: { "if-modified-since": modified },
      });
      expect(replay.status(), path).toBe(304);
      expect(await replay.body(), `${path}: a 304 carries no body`).toEqual(Buffer.alloc(0));
      for (const encoding of ["br", "gzip"]) {
        const compressed = await request.get(serverURL + path, {
          headers: { "accept-encoding": encoding },
        });
        expect(compressed.headers()["content-encoding"], `${path}: ${encoding}`).toBe(encoding);
        expect(await compressed.body()).toEqual(await identity.body());
      }
    }
  });

  test("compression and revalidation obey their request laws", async ({ request, serverURL }) => {
    const identity = await request.get(serverURL + "/", {
      headers: { "accept-encoding": "identity" },
    });
    const body = await identity.body();
    const validator = identity.headers()["last-modified"];
    expect(validator).toMatch(/GMT$/);
    const validatorAt = Date.parse(validator);

    const candidates = ["gzip", "br", "zstd", "deflate"];
    const produced = new Set(["identity"]);
    for (const candidate of candidates) {
      const probe = await request.get(serverURL + "/", {
        headers: { "accept-encoding": candidate },
      });
      if (probe.headers()["content-encoding"] === candidate) produced.add(candidate);
    }
    expect(produced.size, "the server produces a coding beyond identity").toBeGreaterThan(1);

    const coding = fc.constantFrom(...candidates, "identity", "*");
    const quality = fc.option(fc.constantFrom("0", "0.5", "1", "0.001"), { nil: undefined });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(coding, quality), {
          minLength: 1,
          maxLength: 4,
          selector: ([name]) => name,
        }),
        async (offers) => {
          const field = offers
            .map(([name, weight]) => (weight === undefined ? name : `${name};q=${weight}`))
            .join(", ");
          /** @param {string} name */
          const qualityOf = (name) => {
            const named = offers.find(([offered]) => offered === name);
            if (named) return named[1] === undefined ? 1 : Number(named[1]);
            const wildcard = offers.find(([offered]) => offered === "*");
            if (wildcard) return wildcard[1] === undefined ? 1 : Number(wildcard[1]);
            return name === "identity" ? 1 : 0;
          };
          const acceptable = [...produced].some((name) => qualityOf(name) > 0);
          const response = await request.get(serverURL + "/", {
            headers: { "accept-encoding": field },
          });
          expect(response.status(), field).toBe(acceptable ? 200 : 406);
          if (!acceptable) return;
          const applied = response.headers()["content-encoding"] ?? "identity";
          expect(qualityOf(applied), `${field}: selected ${applied}`).toBeGreaterThan(0);
          expect(await response.body(), field).toEqual(body);
          expect(response.headers()["vary"], field).toContain("accept-encoding");
        },
      ),
      { numRuns: Math.min(runs, HTTP_LAW_RUNS) },
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -86_400, max: 86_400 }), async (skew) => {
        const since = new Date(validatorAt + skew * 1_000).toUTCString();
        const response = await request.get(serverURL + "/", {
          headers: { "if-modified-since": since },
        });
        const fresh = Date.parse(since) >= validatorAt;
        expect(response.status(), since).toBe(fresh ? 304 : 200);
        if (fresh) expect(await response.body(), since).toEqual(Buffer.alloc(0));
      }),
      { numRuns: Math.min(runs, HTTP_LAW_RUNS) },
    );

    // PROOF: RFC 9110 IMF-fixdate has this closed shape.
    const imfFixdate = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    const malformedDate = fc
      .stringMatching(/^[ -~]{0,32}$/)
      .filter((value) => value === value.trim() && !imfFixdate.test(value));
    await fc.assert(
      fc.asyncProperty(malformedDate, async (value) => {
        const response = await request.get(serverURL + "/", {
          headers: { "if-modified-since": value },
        });
        expect(response.status(), JSON.stringify(value)).toBe(200);
      }),
      { numRuns: Math.min(runs, HTTP_LAW_RUNS) },
    );
  });

  test("every built asset serves the requested byte range or refuses it", async ({
    request,
    serverURL,
  }) => {
    for (const asset of await builtAssets()) {
      const whole = await (await request.get(serverURL + asset)).body();
      expect(whole.length, asset).toBeGreaterThan(0);
      await fc.assert(
        fc.asyncProperty(
          fc
            .tuple(fc.nat({ max: whole.length - 1 }), fc.nat({ max: whole.length - 1 }))
            .map(([left, right]) => /** @type {[number, number]} */ ([
              Math.min(left, right),
              Math.max(left, right),
            ])),
          async ([start, end]) => {
            const response = await request.get(serverURL + asset, {
              headers: {
                "accept-encoding": "identity",
                range: `bytes=${start}-${end}`,
              },
            });
            expect(response.status(), `${asset}: ${start}-${end}`).toBe(206);
            expect(response.headers()["content-range"], asset).toBe(
              `bytes ${start}-${end}/${whole.length}`,
            );
            expect(await response.body(), asset).toEqual(whole.subarray(start, end + 1));
          },
        ),
        { numRuns: Math.min(runs, HTTP_LAW_RUNS) },
      );
      const beyond = await request.get(serverURL + asset, {
        headers: {
          "accept-encoding": "identity",
          range: `bytes=${whole.length + 1}-${whole.length + 9}`,
        },
      });
      expect(beyond.status(), asset).toBe(416);
    }
  });

  test("authored and built CSS obey the stylesheet contract", async () => {
    const authored = await Array.fromAsync(
      glob("*.css", {
        cwd: join(repoRoot, "web/src/assets/css"),
      }),
    );
    expect(authored.length).toBeGreaterThan(0);
    for (const file of authored) {
      const css = await readFile(join(repoRoot, "web/src/assets/css", file), "utf8");
      expect([...css.matchAll(/(?<![\w-])(-webkit-|-moz-|-ms-|-o-)[a-z-]+/g)]).toEqual([]);
    }
    for (const asset of (await builtAssets()).filter((path) => path.endsWith(".css"))) {
      const css = await readFile(join(templatesDir, treePathOf(asset)), "utf8");
      const absolute = [...css.matchAll(/(?<![\w-])(\d*\.?\d+)px/g)]
        .map((match) => match[1])
        .filter((value) => value !== "1");
      expect(absolute, asset).toEqual([]);
      expect(css, asset).not.toMatch(/!\s*important/);
      expect(css, asset).not.toMatch(/@supports/);
      expect(
        [...css.matchAll(/@media([^{]*)/g)]
          .map((match) => match[1].trim())
          .filter(
            (condition) =>
              !condition.includes("prefers-color-scheme") &&
              !condition.includes("prefers-reduced-motion"),
          ),
        asset,
      ).toEqual([]);
      const layers = [...css.matchAll(/@layer\s+([^{;]+)[{;]/g)].flatMap((match) =>
        match[1].split(",").map((name) => name.trim()),
      );
      expect(
        layers.filter((name) => !["reset", "components"].includes(name)),
        asset,
      ).toEqual([]);
      if (!asset.includes("/root-")) expect(layers, asset).not.toContain("reset");
    }
    const rootAsset = (await builtAssets()).find(
      (asset) => asset.includes("/root-") && asset.endsWith(".css"),
    );
    expect(rootAsset, "the build emits the root stylesheet").toBeDefined();
    const rootCss = await readFile(join(templatesDir, treePathOf(String(rootAsset))), "utf8");
    const established = [...rootCss.matchAll(/@layer\s+([^{;]+)[{;]/g)].flatMap((match) =>
      match[1].split(",").map((name) => name.trim()),
    );
    expect([...new Set(established)], "root layer order").toEqual(["reset", "components"]);
  });

  test("every page stays within the viewport", async ({ page, serverURL }) => {
    for (const path of await builtPages()) {
      if (path === ERROR_PATH) continue;
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 320, max: 2560 }), async (width) => {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(serverURL + path);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${path} at ${width}`).toBe(0);
        }),
        { numRuns: Math.min(runs, VIEWPORT_RUNS) },
      );
    }
  });

  test("request logs carry request and response facts without derived identity", async ({
    request,
  }) => {
    await withCapturedServer(async ({ url, logs }) => {
      const token = "generic-log-witness";
      const response = await request.get(url + "/", {
        headers: { "user-agent": token, referer: "https://example.test/from" },
      });
      expect(response.status()).toBe(200);
      await logs.waitForCount(/event="request\.serve"/g, 1);
      expect(logs.count(new RegExp(token, "g"))).toBe(1);
      expect(logs.count(/visitor=/g)).toBe(0);
      expect(logs.count(/\bip=/g)).toBe(0);
    });
  });
});
