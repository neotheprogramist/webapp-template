// @ts-check
import { expect } from "@playwright/test";

/**
 * @typedef {{ awaitFinding: (kind: string) => Promise<void> }} Witness
 */

export const clientWitnessControls = [
  {
    name: "console, exception, a 404 fetch, and a live-document cancellation",
    kinds: ["console", "exception", "loading-failed", "response-status"],
    /** @param {import('@playwright/test').Page} page @param {Witness} _witness */
    drive: async (page, _witness) => {
      const exceptionSeen = page.waitForEvent("pageerror");
      await page.evaluate(() => {
        console.log("witness-control");
        fetch("/witness-control-missing");
        const controller = new AbortController();
        fetch("/witness-control-aborted", { signal: controller.signal }).catch(() => {});
        controller.abort();
        setTimeout(() => {
          throw new Error("witness-control");
        }, 0);
      });
      await exceptionSeen;
    },
    /** @param {Record<string, string>} detail */
    expectDetail: (detail) => {
      expect(detail["console"]).toContain("witness-control");
      expect(detail["exception"]).toContain("witness-control");
      expect(detail["response-status"]).toContain("/witness-control-missing");
      expect(detail["response-status"]).toContain("404");
      expect(detail["loading-failed"]).toContain("/witness-control-aborted");
    },
  },
  {
    name: "a CSP-blocked subresource",
    kinds: ["issue", "loading-failed", "log-entry"],
    /** @param {import('@playwright/test').Page} page @param {Witness} _witness */
    drive: async (page, _witness) => {
      await page.evaluate(() => {
        const img = document.createElement("img");
        img.src = "https://example.invalid/witness-control.png";
        document.body.appendChild(img);
      });
    },
    /** @param {Record<string, string>} detail */
    expectDetail: (detail) => {
      expect(detail["loading-failed"], "the failure names why it was blocked").toContain(
        "blocked: csp",
      );
      expect(detail["log-entry"], "the log entry is the security channel").toContain("security");
      expect(detail["issue"], "the DevTools issue is the CSP one").toContain(
        "ContentSecurityPolicyIssue",
      );
    },
  },
  {
    name: "a prefetch that fails",
    kinds: ["prefetch", "response-status"],
    /** @param {import('@playwright/test').Page} page @param {Witness} witness */
    drive: async (page, witness) => {
      await page.evaluate(() => {
        const rules = document.createElement("script");
        rules.type = "speculationrules";
        rules.textContent = JSON.stringify({
          prefetch: [{ urls: ["/witness-control-missing"], eagerness: "immediate" }],
        });
        document.head.appendChild(rules);
      });
      await witness.awaitFinding("prefetch");
    },
    /** @param {Record<string, string>} detail */
    expectDetail: (detail) => {
      expect(detail["prefetch"]).toContain("/witness-control-missing");
      expect(detail["prefetch"]).toContain("PrefetchFailedNon2XX");
      expect(detail["response-status"]).toContain("404");
    },
  },
  {
    name: "a javascript dialog",
    kinds: ["dialog"],
    /** @param {import('@playwright/test').Page} page @param {Witness} _witness */
    drive: async (page, _witness) => {
      const opened = page.waitForEvent("dialog");
      page.on("dialog", (dialog) => void dialog.dismiss());
      void page.evaluate(() => alert("witness-control")).catch(() => {});
      await opened;
    },
    /** @param {Record<string, string>} detail */
    expectDetail: (detail) => {
      expect(detail["dialog"]).toContain("witness-control");
    },
  },
];

export const CRASH_KIND = "crash";

export const PURE_DRIVEN_KINDS = Object.freeze([
  "response-status",
  "cross-origin",
  "loading-failed",
  "log-entry",
]);

export const CONTROLLED_KINDS = Object.freeze([
  ...new Set([
    ...clientWitnessControls.flatMap((control) => control.kinds),
    CRASH_KIND,
    ...PURE_DRIVEN_KINDS,
  ]),
]);
