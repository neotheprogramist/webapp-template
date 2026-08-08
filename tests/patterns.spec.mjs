// @ts-check
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import {
  escapeRegExp,
  PAGE_FILE,
  REGEXP_METACHARACTERS,
  robotsDirective,
  treePathOf,
  urlPathOf,
  withoutTrailingSlash,
} from "./utils/patterns.mjs";

const OVER_MATCHES = [
  ["a.c", "abc"],
  ["a+", "aa"],
  ["a*", ""],
  ["a?", ""],
  ["(a)", "a"],
  ["[a]", "a"],
  ["a|b", "a"],
  ["a{1}", "a"],
  ["^a", "a"],
  ["a$", "a"],
  ["a\\b", "ab"],
];

test("escapeRegExp makes a literal match itself and not its regex imposter", () => {
  const classChars = REGEXP_METACHARACTERS.source.slice(1, -1).replace(/\\(.)/g, "$1");
  for (const char of classChars) {
    expect(
      OVER_MATCHES.some(([pattern]) => pattern.includes(char)),
      char,
    ).toBe(true);
  }
  for (const [pattern, imposter] of OVER_MATCHES) {
    expect(new RegExp(`^${escapeRegExp(pattern)}$`).test(imposter), pattern).toBe(false);
  }
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (literal) => {
      expect(new RegExp(`^${escapeRegExp(literal)}$`).test(literal)).toBe(true);
    }),
  );
});

test("page and tree path conversions round-trip", () => {
  fc.assert(
    fc.property(fc.array(fc.stringMatching(/^[a-z0-9-]{1,10}$/), { maxLength: 4 }), (parts) => {
      const dir = parts.length === 0 ? "" : `${parts.join("/")}/`;
      for (const extension of ["html", "md", "njk"]) {
        expect(PAGE_FILE.test(`index.${extension}`)).toBe(true);
        expect(urlPathOf(`${dir}index.${extension}`)).toBe(`/${dir}`);
      }
      expect(treePathOf(`/${dir}`)).toBe(dir);
      expect(withoutTrailingSlash(`/${dir}`)).toBe(`/${dir}`.replace(/\/$/, ""));
    }),
  );
});

test("robotsDirective matches a complete active directive line", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Z][a-z-]{2,12}$/),
      fc.stringMatching(/^[a-z0-9/*.:-]{1,20}$/),
      (name, value) => {
        const pattern = robotsDirective(name, value);
        expect(pattern.test(`${name}: ${value}\n`)).toBe(true);
        for (const inert of [
          `# ${name}: ${value}\n`,
          `  ${name}: ${value}\n`,
          `X${name}: ${value}\n`,
          `${name}: ${value}x\n`,
        ]) {
          expect(pattern.test(inert), inert).toBe(false);
        }
      },
    ),
  );
});
