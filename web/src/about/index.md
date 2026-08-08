---
layout: layouts/page.njk
title: About | Webapp Template
description: The boundaries and customization points of the reusable webapp scaffold.
heading: About this scaffold
---

This is a runnable reference implementation, not a prefilled product. Its default content describes
only behavior the repository currently ships.

## Included

- Eleventy pages and static assets
- a Rust static server with security headers, compression, TLS modes, and graceful shutdown
- typed content metadata, structured data, and generated sitemap, robots, feed, and llms artifacts
- browser, property, mutation, and contract checks

## Intentionally absent

Analytics, contact collection, authentication, persistence, server-rendered fragments, and client
islands arrive only when an application has a concrete requirement for them.

The [repository README](https://github.com/neotheprogramist/webapp-template) owns setup and runnable
commands.
