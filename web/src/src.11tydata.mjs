// @ts-check
const site = Object.freeze({
  url: "https://webapp-template.example.invalid",
  name: "Webapp Template",
  description: "A typed static-first Eleventy and Rust scaffold for new web applications.",
  language: "en",
  locale: "en_US",
});

// Policy: prefetch moderately to bound speculative origin traffic.
const speculationRules = Object.freeze({
  prefetch: [{ where: { href_matches: "/*" }, eagerness: "moderate" }],
});

/** @typedef {{ page: { url: string }, heading: string, description: string }} PageData */

function website() {
  return {
    "@type": "WebSite",
    "@id": site.url + "/#website",
    name: site.name,
    description: site.description,
    url: site.url + "/",
  };
}

/** @param {PageData} data */
function webPage(data) {
  const url = site.url + data.page.url;
  return {
    "@type": "WebPage",
    "@id": url + "#webpage",
    name: data.heading,
    description: data.description,
    url,
    isPartOf: { "@id": site.url + "/#website" },
  };
}

export default {
  site,
  speculationRules,
  eleventyComputed: {
    /** @param {PageData} data */
    schema: (data) => ({
      "@context": "https://schema.org",
      "@graph": [webPage(data), ...(data.page.url === "/" ? [website()] : [])],
    }),
  },
};
