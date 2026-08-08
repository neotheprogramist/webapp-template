// @ts-check
// @ts-expect-error — @11ty/eleventy-plugin-vite has no declarations.
import EleventyVitePlugin from "@11ty/eleventy-plugin-vite";
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import htmlmin from "html-minifier-terser";
import { parse as parseFrontMatter } from "./src/content.schema.mjs";

/**
 * Boundary type for the untyped Eleventy 3 configuration API used here.
 * @param {{
 *   addPreprocessor: (name: string, extensions: string, callback: (this: { inputPath: string }) => unknown) => void,
 *   amendLibrary: (name: string, amend: (lib: { set: (options: object) => unknown }) => unknown) => void,
 *   addPassthroughCopy: (target: string | Record<string, string>) => void,
 *   addPlugin: (plugin: unknown, options?: object) => void,
 *   addTransform: (name: string, transform: (this: { page: { outputPath: string | false } }, content: string) => unknown) => void,
 * }} eleventyConfig
 */
export default function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyVitePlugin);

  eleventyConfig.addPreprocessor("content-schema", "md,njk", async function () {
    const source = await readFile(this.inputPath, "utf8");
    parseFrontMatter(matter(source).data, this.inputPath);
  });

  // Keep raw HTML and template syntax inert in Markdown.
  eleventyConfig.amendLibrary("md", (md) => md.set({ html: false }));

  // Leave embedded JSON untouched while minifying markup.
  eleventyConfig.addTransform("htmlmin", function (content) {
    if (!(this.page.outputPath || "").endsWith(".html")) return content;
    return htmlmin.minify(content, {
      useShortDoctype: true,
      removeComments: true,
      collapseWhitespace: true,
    });
  });

  eleventyConfig.addPassthroughCopy("src/assets");

  return {
    templateFormats: ["md", "njk"],
    markdownTemplateEngine: false,
    dir: {
      input: "src",
      output: "../server/templates",
    },
  };
}
