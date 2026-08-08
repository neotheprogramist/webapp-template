// @ts-check
// PROOF: every metacharacter matched here is escaped by the replacement.
export const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** @param {string} literal */
export const escapeRegExp = (literal) => literal.replace(REGEXP_METACHARACTERS, "\\$&");

// PROOF: Eleventy maps each directory index source in place.
export const PAGE_FILE = /index\.(?:html|md|njk)$/;

/** @param {string} file */
export const urlPathOf = (file) => `/${file.replace(PAGE_FILE, "")}`;

/** @param {string} path */
export const treePathOf = (path) => path.replace(/^\//, "");

/** @param {string} path */
export const withoutTrailingSlash = (path) => path.replace(/\/$/, "");

/** @param {string} name @param {string} value */
export const robotsDirective = (name, value) =>
  new RegExp(`^${escapeRegExp(name)}: ${escapeRegExp(value)}$`, "m");
