// @ts-check
import { expect } from "@playwright/test";
import srcData from "../../web/src/src.11tydata.mjs";

/** @param {string} html @param {string} label */
export function parseJsonLd(html, label) {
  const block = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  expect(block, `${label}: carries a JSON-LD block`).not.toBeNull();
  return JSON.parse(/** @type {RegExpMatchArray} */ (block)[1])["@graph"];
}

/** @param {any} node @param {string} path @param {string} html */
export function expectWebPageNode(node, path, html) {
  const absolute = srcData.site.url + path;
  expect(node["@id"], `${path}: WebPage @id`).toBe(`${absolute}#webpage`);
  expect(node.url, `${path}: WebPage url`).toBe(absolute);
  expect(node.name, `${path}: WebPage name is the h1`).toBe(html.match(/<h1>([^<]+)<\/h1>/)?.[1]);
  expect(node.description, `${path}: WebPage description is the meta description`).toBe(
    html.match(/<meta name="description" content="([^"]*)"/)?.[1],
  );
  expect(node.isPartOf, `${path}: WebPage belongs to the one site`).toEqual({
    "@id": srcData.site.url + "/#website",
  });
}
