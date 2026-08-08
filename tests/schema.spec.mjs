// @ts-check
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import matter from "gray-matter";
import { ContentSchemaError, parse } from "../web/src/content.schema.mjs";
import { repoRoot } from "./utils/server.mjs";

const srcDir = join(repoRoot, "web/src");

/** @typedef {[string, Record<string, unknown>]} Source */

async function sources() {
  const paths = [
    ...(await Array.fromAsync(glob("**/*.md", { cwd: srcDir }))),
    ...(await Array.fromAsync(glob("**/*.njk", { cwd: srcDir }))),
  ]
    .filter((path) => !path.startsWith("_includes/"))
    .sort();
  return Promise.all(
    paths.map(async (path) => /** @type {Source} */ ([
      path,
      matter(await readFile(join(srcDir, path), "utf8")).data,
    ])),
  );
}

/** @param {() => unknown} operation @param {string} inputPath @param {string} detail */
function expectSchemaError(operation, inputPath, detail) {
  expect(operation).toThrow(ContentSchemaError);
  expect(operation).toThrow(`${inputPath}: ${detail}`);
  try {
    operation();
  } catch (error) {
    expect(error).toHaveProperty("name", "ContentSchemaError");
  }
}

test("every source parses once into a frozen value without its layout discriminator", async () => {
  const entries = await sources();
  expect(entries.length).toBeGreaterThan(0);
  for (const [path, frontMatter] of entries) {
    const value = parse(frontMatter, path);
    expect(Object.isFrozen(value), path).toBe(true);
    expect(value, path).not.toHaveProperty("layout");
    for (const [name, field] of Object.entries(frontMatter)) {
      if (name !== "layout") expect(value[name], `${path}: ${name}`).toEqual(field);
    }
  }
});

test("every declared field is required and invalid values are refused by name", async () => {
  for (const [path, frontMatter] of await sources()) {
    for (const name of Object.keys(frontMatter).filter((field) => field !== "layout")) {
      const missing = { ...frontMatter };
      delete missing[name];
      expectSchemaError(
        () => parse(missing, path),
        path,
        `front matter is missing required "${name}"`,
      );

      const invalid = {
        ...frontMatter,
        [name]: name === "eleventyExcludeFromCollections" ? false : "",
      };
      const problem =
        name === "eleventyExcludeFromCollections"
          ? "must be true when present"
          : name === "permalink"
            ? "must be a rooted path string"
            : "must be a non-empty string";
      expectSchemaError(() => parse(invalid, path), path, `"${name}" ${problem}`);
    }
  }
});

test("unknown fields and layouts fail at the content boundary", async () => {
  for (const [path, frontMatter] of await sources()) {
    const known = Object.keys(frontMatter).filter((name) => name !== "layout");
    expectSchemaError(
      () => parse({ ...frontMatter, "Stryker was here": "value" }, path),
      path,
      'front matter carries "Stryker was here", which this page kind does not declare (allowed: ' +
        known.join(", ") +
        ")",
    );
  }
  for (const layout of ["layouts/not-a-kind.njk", 42]) {
    expectSchemaError(
      () =>
        parse(
          {
            layout,
            title: "Title",
            description: "Description",
            heading: "Heading",
          },
          "unknown.md",
        ),
      "unknown.md",
      `layout ${JSON.stringify(layout)} names no page kind — add a row to content.schema.mjs`,
    );
  }
});

test("artifact permalinks must be rooted paths", () => {
  const artifact = {
    layout: null,
    permalink: "robots.txt",
    eleventyExcludeFromCollections: true,
  };
  expectSchemaError(
    () => parse(artifact, "robots.njk"),
    "robots.njk",
    '"permalink" must be a rooted path string',
  );
});

test("required prose strings reject non-strings and whitespace-only strings", () => {
  const page = {
    layout: "layouts/page.njk",
    title: "Title",
    description: "Description",
    heading: "Heading",
  };
  for (const title of [42, "   "]) {
    expectSchemaError(
      () => parse({ ...page, title }, "page.md"),
      "page.md",
      '"title" must be a non-empty string',
    );
  }
});
