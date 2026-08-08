// @ts-check
export class ContentSchemaError extends Error {
  /** @param {string} inputPath @param {string} detail */
  constructor(inputPath, detail) {
    super(inputPath + ": " + detail);
    this.name = "ContentSchemaError";
  }
}

/** @param {unknown} value */
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

/** @type {Record<string, (value: unknown) => string>} */
const FIELDS = {
  title: (value) => (isNonEmptyString(value) ? "" : "must be a non-empty string"),
  description: (value) => (isNonEmptyString(value) ? "" : "must be a non-empty string"),
  heading: (value) => (isNonEmptyString(value) ? "" : "must be a non-empty string"),
  permalink: (value) =>
    isNonEmptyString(value) && /** @type {string} */ (value).startsWith("/")
      ? ""
      : "must be a rooted path string",
  eleventyExcludeFromCollections: (value) => (value === true ? "" : "must be true when present"),
};

export const SHELL = Symbol("no layout — structural shell");
export const ARTIFACT = Symbol("layout: null — non-HTML artifact");

/** @typedef {{ require: string[], allow: string[] }} Kind */

/** @type {Array<[string | symbol, Kind]>} */
const KIND_ROWS = [
  [SHELL, { require: ["title", "description", "heading"], allow: [] }],
  [ARTIFACT, { require: ["permalink", "eleventyExcludeFromCollections"], allow: [] }],
  ["layouts/page.njk", { require: ["title", "description", "heading"], allow: [] }],
  [
    "layouts/404/page.njk",
    {
      require: ["title", "description", "heading", "eleventyExcludeFromCollections"],
      allow: [],
    },
  ],
];

/** @type {Map<unknown, Kind>} */
const KINDS = new Map(KIND_ROWS);

/** @param {Record<string, unknown>} frontMatter */
function kindKeyOf(frontMatter) {
  if (!("layout" in frontMatter)) return SHELL;
  const { layout } = frontMatter;
  if (layout === null) return ARTIFACT;
  return layout;
}

/** @param {Record<string, unknown>} frontMatter @param {string} inputPath */
export function parse(frontMatter, inputPath) {
  const key = kindKeyOf(frontMatter);
  const kind = KINDS.get(key);
  if (!kind) {
    throw new ContentSchemaError(
      inputPath,
      "layout " +
        JSON.stringify(frontMatter.layout) +
        " names no page kind — add a row to content.schema.mjs",
    );
  }

  const declared = Object.keys(frontMatter).filter((name) => name !== "layout");
  const known = [...kind.require, ...kind.allow];
  for (const name of declared) {
    if (!known.includes(name)) {
      throw new ContentSchemaError(
        inputPath,
        'front matter carries "' +
          name +
          '", which this page kind does not declare (allowed: ' +
          known.join(", ") +
          ")",
      );
    }
  }
  for (const name of kind.require) {
    if (!(name in frontMatter)) {
      throw new ContentSchemaError(inputPath, 'front matter is missing required "' + name + '"');
    }
  }

  /** @type {Record<string, unknown>} */
  const parsed = {};
  for (const name of declared) {
    const problem = FIELDS[name](frontMatter[name]);
    if (problem) throw new ContentSchemaError(inputPath, '"' + name + '" ' + problem);
    parsed[name] = frontMatter[name];
  }
  return Object.freeze(parsed);
}
