# Building Webapps — A Guide for Agents

`AGENTS.md` is the repository contract and wins on conflict. This guide describes the current web
stack and the accepted shapes for extending it; `README.md` owns runnable commands. Read only the
sections relevant to the task. A planned component describes a future boundary, not authorization
to implement it. File paths name locations in the skeleton (§1).

---

## The organizing idea: binding times

Classify **every piece of HTML by when its data is bound** (**P**).

| Data is bound…   | It is a…            | Engine                       | Lives in                |
| ---------------- | ------------------- | ---------------------------- | ----------------------- |
| at build time    | **page** (constant) | Eleventy (md + Nunjucks)     | `web/src/`              |
| at deploy time   | **policy constant** | one Rust/TS constants module | `server/src/policy.rs`  |
| at request time  | **fragment**        | Askama (Rust, type-checked)  | `web/public/fragments/` |
| client-side only | **island**          | vanilla `.mjs`, native ESM   | `web/src/assets/js/`    |

A page bound entirely at build time is a **total specialization** — the template stage collapses to
a constant file. A fragment is the **residual program**, the part that awaits request-time input. An
island is the part whose truth must never reach the server (**A4**).

Three consequences:

- **One engine per file, never two.** The congruence condition: no artifact may straddle two binding
  times. No delimiter split, no escaping convention, no two-stage evaluation.
- **The residual program is typed, not stringly.** Askama type-checks every interpolation against
  its struct at `cargo build`, so a missing field is a build error rather than a blank. A fragment
  template is hand-written and passes through the build **verbatim**, so it is never something an
  earlier stage generated — the classic staging hole is closed at the source.
- **One output tree, staged coupling.** The build writes the whole static site to one directory; the
  server is pointed at it by a flag _and_ compiles its fragments from it. So `cargo check` needs a
  built tree once a fragment exists, and every frontend build rewrites those files with fresh
  mtimes, forcing a server recompile. That is the price of one output tree with zero sync
  machinery; §7's harness ordering pays it.

---

## Scope follows the tree (**A4**)

There is no global state — the filesystem subtree is the unit of visibility, and a shared
artifact belongs at the **lowest common ancestor** of its consumers.

| Artifact      | Scoped how                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Layouts       | named by each page's front-matter `layout:`; templates at the mirrored path under `_includes/layouts/`    |
| Partials      | at the `_includes/` root, included by `{% include %}` — structure and chrome only, never content          |
| CSS           | one sheet per subtree in `src/assets/css/`, `@scope`-scoped, linked by that subtree's layout              |
| JS            | island modules in `src/assets/js/`; imports point up (ancestors) or in (own subtree), never sideways      |
| Runtime state | owned by one island, crossed only by `CustomEvent` — never `globalThis`, never a mutable module singleton |

The root is the only tree-wide scope, and placing something there is a deliberate cost: `:root`
design tokens are the only tree-wide CSS values, one root module the only tree-wide JS. Visibility
that mirrors the directory tree makes the structure the dependency graph — a subtree reads in
isolation and deletes without a grep.

---

## How to use this guide

For a web change, inspect the existing implementation, select the topology in §0, make the smallest
vertical slice that reaches an observable result, and run the relevant gates in §8. Do not add a
planned dependency or boundary unless the task requires its first concrete use.

Capability status is explicit:

| Status         | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| **Shipped**    | Present in this repository and covered by its standing gates             |
| **Extension**  | The accepted shape when a concrete application requirement introduces it |
| **Case study** | A pattern measured in an application derived from this template          |
| **Planned**    | A selected topology with no shipped implementation yet                   |

The baseline ships static pages, the Rust static server, optional TLS, deployment workflows and
their witnesses. It ships no form, analytics, visitor identity, telemetry sink, island, content
collection or server-rendered fragment. Sections describing those boundaries are extension rules or
case studies, never claims about the baseline tree.

---

## Decisions at a glance

Each row is already decided. Deviate only with an explicit recorded reason.

| Area        | Use                                                                                     | Why                                                              | Never                                                   |
| ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Repo        | Monorepo: Cargo workspace + npm workspaces                                              | One clone, one version graph                                     | Split repos that drift                                  |
| Toolchains  | Pin: `rust-toolchain.toml` + `mise.toml`                                                | Reproducible from a clean clone                                  | Whatever is installed                                   |
| Backend     | Rust 2024 + axum + tokio                                                                | Types are proofs; one binary                                     | Dynamic servers                                         |
| Fragments   | Askama (`#[derive(Template)]`, compiled) — **planned; none shipped yet**                | Typed residual program; markup lives with the rest of the markup | Runtime template engines; stringly rendering            |
| Pages       | Eleventy: `index.md` + Nunjucks layouts, build-time                                     | Content is a file; resolves to constants                         | Runtime engines for build-bound HTML                    |
| Content     | One `index.md` per prose page; front matter parsed by a **typed schema**                | Metadata is parsed once, at the build boundary (P2)              | Template strictness flags as validation                 |
| Routing     | Filesystem = URL                                                                        | Adding a page is adding a directory                              | Route registration, generator scripts                   |
| Bundler     | Vite via `@11ty/eleventy-plugin-vite`                                                   | Bundles, hashes, minifies into `/assets/`; HMR in dev            | A separate frontend deploy; sync scripts                |
| Frontend JS | Vanilla `.mjs` + JSDoc + `// @ts-check`                                                 | The type checker runs; the runtime is plain JS; no lock-in       | Frameworks; `.ts` emit; script for what HTML/CSS can do |
| CSS         | Hand-written: `:root` tokens + `@scope` sheets                                          | Scoped styles cannot collide; tokens are the only globals        | Tailwind/CSS-in-JS; unscoped component CSS              |
| Delivery    | htmx for fragment swaps, when a fragment exists — **not in the manifest**               | Hypermedia touches server truth only                             | Signal frameworks needing `unsafe-eval`                 |
| SPA feel    | View Transitions + Speculation Rules                                                    | ~0 bytes of routing JS                                           | A client router                                         |
| Errors      | thiserror, one enum per boundary, `#[from]`                                             | Errors are values (A2)                                           | `anyhow`, per-call `.map_err`                           |
| Config      | clap `derive` + `env`                                                                   | Every knob is a flag and an env var                              | Hard-coded hosts, ports, paths                          |
| Logging     | tracing, `event = "noun.verb"`                                                          | Greppable, stable field identity                                 | `println!`; JSON noise for one node                     |
| Lint/format | oxlint (+ oxfmt), `tsc`                                                                 | Fast; type-aware coverage still narrower than typescript-eslint  | ESLint/Prettier stacks                                  |
| Tests       | Playwright E2E + fast-check + mutation gates (+ model-based specs once a `step` exists) | Real implementations, invariants, proven teeth                   | Unit tests over mocks                                   |

Three that surprise: **pages are static files** — the server never renders one; **fragment sources
live under `web/public/fragments/`** and ride the passthrough into the built tree the server
compiles from (§1); **there is no client router**.

---

## §0 — Choose the topology (**A4**, confidentiality)

Static-first. Escalate only when the truth's label demands it.

- **Static page** — bound at build time. Marketing, blog, docs, and the _shells_ of apps. Needs
  no backend beyond a file server.
- **Server-truth fragment** — exists only on the server at request time. _Decision rule: if a
  second client must see it, or only the server can compute it, it is server truth._
- **Client-truth island** — must never reach the server: keys, secrets, local proofs, wallet
  interactions. _Decision rule: if sending it would be a bug or an avoidable privacy leak, it is
  client truth._

**The offload principle (A4).** Push computation to the highest label at which it is feasible.
The server receives results and commitments, never private inputs. Canonical offloads:

- **Keys** — generate client-side; WebCrypto keys with `extractable: false` cannot be exported
  even by your own script, so key material is confined by construction (P1 applied to secrets).
- **Signatures and encryption** — sign where the key lives; ship ciphertext and signatures.
- **ZK proof generation** — prove in wasm on the client; the server verifies. The witness never
  crosses the wire, so the server cannot see it even in principle.
- **Small-model inference** — WebGPU/wasm engines keep prompts and outputs on-device.

**Feasibility is measured, not assumed.** Client compute has hard ceilings: a wasm prover must
budget its trace against the wasm memory ceiling, and sub-second proving on desktop degrades
sharply on mobile. Where full offload is infeasible, minimize what crosses — a commitment, a
blinded value, a partial computation — rather than defaulting downward.

Do not let a framework blur the partition: hypermedia that moves state to the backend cannot absorb
client-truth code, and a client framework should not re-render what a static page states.

---

## §1 — Lay out the baseline repo

```
.
├── AGENTS.md  WEBAPP.md            # contract + this guide
├── Cargo.toml                      # Rust workspace; dependencies live HERE
├── package.json                    # "workspaces": ["web", …]; deps live HERE (hoisted)
├── rust-toolchain.toml  mise.toml  # pinned toolchains
├── jsconfig.json                   # checkJs + strict; covers islands, tests, and build config
├── playwright.config.mjs
├── contract.yaml                   # the ast-grep half of the contract (§8)
├── crates/shutdown/                # typed Unix shutdown event
├── server/
│   ├── src/{main,lib,config,error,router,serve,policy,headers,patterns}.rs
│   ├── src/policy.rs               # ALL deploy-time constants, each justified (P4)
│   ├── src/routes/version.rs       # shipped server-truth resource
│   ├── src/bin/certgen.rs          # dev-cert tool (feature `self-signed`, §5)
│   └── templates/                  # THE build output (gitignored) — served, and the
│                                   #   directory Askama compiles fragments from (§3)
├── web/                            # all HTML/CSS/TS source
│   ├── eleventy.config.mjs
│   ├── public/favicon.svg          # verbatim passthrough (favicon.svg → /)
│   └── src/
│       ├── content.schema.mjs       # THE front-matter schema (§2) — the build-time boundary
│       ├── src.11tydata.mjs         # site identity + computed JSON-LD
│       ├── sitemap.njk  robots.njk  llms.njk  feed.njk
│       ├── _includes/
│       │   ├── nav.njk  footer.njk  render.njk
│       │   └── layouts/
│       │       ├── layout.njk      # ROOT layout
│       │       ├── page.njk        # shared prose layout
│       │       └── 404/page.njk
│       ├── assets/css/             # root + per-subtree sheets
│       ├── index.njk
│       ├── about/index.md
│       └── 404/index.md
└── tests/                          # Playwright specs + fixtures
```

Extension directories named later — `web/public/fragments/`, collection layouts and
`web/src/assets/js/` — arrive only with their first concrete consumer.

Rules:

- **Pin toolchains.** A clean clone plus documented setup produces a working system.
- **Commit source, ignore artifacts:** `target/`, `node_modules/`, `server/templates/`. Nothing
  under `web/` is generated — fragment sources will live at `web/public/fragments/` and be
  committed (none exist yet); only their copy in the built tree is ignored.
- **The two builds are staged.** The server takes `--templates-dir` (flag + env, clap). The frontend
  build precedes the _server run_ always, and the _server build_ too from the first fragment onward,
  since Askama resolves `#[template(path = …)]` from `server/templates/`. §7's ordering satisfies
  both.
- **Dependencies at the root workspace.** Workspace manifests own only their verbs. The line is
  mechanical: if source has to `import` it, it is a dependency; a tool that is only ever a command
  runs through `npx` and stays out of the manifest.

---

## §2 — Pages: build-time HTML

Pages are `index.md` (content) and `index.njk` (structural shells) resolved by Eleventy. `index.*`
maps in place, so `src/blog/<slug>/index.md` emits `blog/<slug>/index.html` — the directory-index
shape the static handler expects.

`eleventy.config.mjs` is the whole configuration: `eleventy-plugin-vite`; markdown-it with
`html: false`; `markdownTemplateEngine: false` (one engine per file); `src/assets/{css,js}` and
`public/` passthrough; an HTML-minify transform.

- **Front matter is parsed by a typed schema, once, at the build boundary (P2).**
  `content.schema.mjs` declares one schema per page kind, and Eleventy parses every source through
  it. A source whose metadata fails its kind **aborts the build with a named error**. This is the
  parse, not a strictness flag: a template engine's undefined-variable setting fires at render time
  on whatever the template happens to emit — a runtime check wearing a boundary's clothes.
- **Layouts are per-subtree**, and the extends chain is the directory path (**A4**).
  `_includes/layouts/layout.njk` is the root layout: doctype, viewport, SEO/social defaults, the
  root stylesheet link, speculation rules, `{% block %}` slots. A subtree needing its own shell adds
  `_includes/layouts/<dir>/layout.njk`, extending the **nearest ancestor** and contributing to
  `head` via `{{ super() }}`. A **single-page subtree earns no `layout.njk`** — its `page.njk`
  extends the nearest ancestor directly. A layout that opts out of chrome overrides the blocks to
  empty; no detection attributes, no conditionals.
- **Long-form pages share one document component.** Each page keeps its subtree layout and uses a
  semantic `article`; the root stylesheet owns typography shared across subtrees. Collection
  indexes use a semantic `section`, then append their own cards or FAQ. One renderer include owns
  the trusted Markdown rendering boundary.
- **Discoverability head, single-sourced.** `src.11tydata.mjs` holds site identity beside the JSON-LD
  it feeds; each page contributes `page.url`, yielding a self-referential canonical, a matching
  `og:url` and absolute social images. One `@graph` per page is computed there: an Organization +
  WebSite backbone everywhere, plus one conditional node per page type from a registry — a new page
  type is a new row. Every node is built from the same parsed data the page renders, so structured
  data cannot drift from visible copy (P1), and the e2e witnesses both halves of each iff. The
  `| safe` emission carries a `PROOF:` note naming the trust source. This matters doubly because AI
  crawlers read raw HTML without executing JS.
- **Content lives in Markdown; njk and CSS carry structure and styling only.** A prose page is one
  file. `page.njk` emits the chrome and calls `renderContent`; `render.njk` owns the one enumerated
  autoescape bypass, justified because markdown-it runs with `html: false`, so raw HTML and
  template delimiters stay inert. Copy embedded in **structural UI** (a hero, a card grid, a
  disclosure widget) is that structure's text and stays in the njk that owns it; moving it to md
  would take HTML-in-markdown or a transformer, both forbidden. One exception: **structured-list
  content** — typed records that a template loop and a JSON-LD builder both consume — lives in front
  matter as schema-parsed data.
  Style prose by structure, not class, so markdown stays classless.
- **Listings derive from front matter.** A page tags itself into a collection via `tags:`; the
  listing is an `index.md` whose `list.njk` loops it. Adding a post is one directory and one
  `index.md`, and the e2e set-equality proves it is linked. No placeholder entries — a card with
  `href="#"` is copy with nowhere to link. A listing carries no `tags:`, so it never collects itself.
- **Non-HTML artifacts are ordinary templates.** `sitemap.xml`, `robots.txt`, `llms.txt` and the
  Atom `feed.xml` are one `.njk` each at the `src/` root, sharing one idiom: `permalink:` +
  `layout: null` + `eleventyExcludeFromCollections: true`. Never a custom plugin or build script.
  They are `content.schema.mjs`'s `ARTIFACT` kind, so the schema drives them like any page.
  - `Date.prototype.toISOString()` is the **one machine-date formatter** for `<lastmod>`,
    `<updated>` and `datePublished`, so cross-artifact date equality holds by construction.
  - The root layout advertises the feed with `<link rel="alternate">`.
  - Policy: robots.txt allows every crawler — presence in AI answers and search indexes outweighs
    content protection here.
  - Nothing in the application depends on `llms.txt`; generate it from existing content rather
    than maintaining another source.
- Name **page** templates `.njk` and **never rename one to `.html`**: a plain `.html` source passes
  through unprocessed and ships raw delimiters, which the e2e flags. A §3 fragment source is `.html`
  for that reason inverted — it is _meant_ to pass through, and carries no delimiters to ship.
  Editor highlighting is a per-developer concern; `.vscode/` and `.idea/` are gitignored, and oxfmt
  skips `.njk`.

---

## §3 — Fragments: request-time HTML

A fragment is HTML whose data is bound at request time. Its **source lives with the rest of the
markup** (`web/public/fragments/*.html`), passes through the build verbatim, and lands in the output
tree the server serves. Askama compiles it from that directory — its default, so zero configuration:

```rust
// server/src/routes/receipt.rs
#[derive(Template)]
#[template(path = "fragments/receipt.html")]   // resolves from server/templates/
struct ReceiptTpl {
    id: String,
    settled_at: String,
}
```

The handler lives in `server/src/routes/`, one file per resource, and returns the rendered
template. Delivery is htmx: the page declares `hx-post="/api/receipt" hx-target="#receipt"
hx-swap="innerHTML"`, the handler renders, htmx swaps.

- **Askama rather than a runtime engine**, because `rustc` checks the fragment at `cargo build`: a
  missing field is a build error rather than a blank, and escaping is on by default.
- **A template file rather than a Rust macro body**, so the markup lives beside the markup it is
  swapped into and no second templating vocabulary enters the Rust crate.

Two consequences to embrace, not fight:

- The raw template file **is publicly served** — `/fragments/receipt.html` returns the unrendered
  source. It contains no data; this is intended, and the `/assets/` invariant below keeps such a
  file from linking a content-hashed path.
- Every build rewrites the fragment files with fresh mtimes, so **cargo recompiles the server** and
  `cargo check` needs a built tree at all. This is why §7's ordering is a contract, not a convention.

**Fragments are headless.** No doctype, no head, no chrome, no stylesheet link — they are swapped
into a page that already has all of that. A fragment that wants a stylesheet is a page: put it in
`web/src/` and redirect to it.

**`public/` is verbatim territory.** Vite post-processes only what Eleventy emits; `public/` is
copied to the output root as is — not bundled, not hashed, absent from any manifest. `/assets/`
is precisely the content-hashed namespace, so:

> A `/assets/…` reference inside a `public/` file is dangling **by construction** — it names a
> source path the built tree does not contain. Generally: **a verbatim file may only reference
> stable, verbatim paths.**

The passthrough spec asserts this over every `public/` file, so the rule is mechanical.

**htmx enters the manifest with the first fragment, not before** — until then it is a documented
decision, not a shipped byte. Pin its major when it is introduced.

---

## §4 — Islands: client-truth compute

**JavaScript is the escalation of last resort.** Write it only for computation, protocol or state.
Anything expressible as HTML or CSS is expressed as HTML or CSS: navigation, layout, animation,
transitions, menus, modals, disclosure, validation affordances. A page earns an island by needing
client-truth compute, never by wanting an effect.

Source is native `.mjs` with JSDoc and `// @ts-check` on every file: the type checker runs over
everything, nothing is compiled or emitted. The cost is JSDoc's narrower expressiveness — accepted,
because a shipped file being exactly the file you wrote is worth more than the last few percent of
the type system.

### What an island is

The static page is the sea; an island is a bounded interactive region that hydrates independently,
in parallel and in isolation with no shared state tree. The page is readable and navigable before
any island wakes; a page with no island ships zero script.

Every island is two modules:

- a **loader** — the HTML-referenced entry, the only module allowed top-level effects. It owns the
  hydration rung, calls `mount` once per root, and owns each teardown `mount` returns.
- the **island module** — body is imports and declarations only, exporting one `mount(root)` that
  returns its teardown.

So the initialization contract never changes across rungs, N instances mount cleanly, and single
evaluation is honest by construction: an init guard would mean the module body has an illegal effect.

| Rung      | Native primitive                              | Use for                            |
| --------- | --------------------------------------------- | ---------------------------------- |
| load      | `<script type="module">` (deferred by spec)   | critical, immediately-visible UI   |
| idle      | `requestIdleCallback` (+ named deadline)      | non-critical UI                    |
| visible   | `IntersectionObserver` (+ named `rootMargin`) | below-the-fold or expensive UI     |
| media     | `matchMedia` + change listener                | breakpoint-only UI                 |
| on-demand | one-shot listener + dynamic `import()`        | **heavy compute: provers, models** |

Pick the **lowest** rung that satisfies the UX; heavy compute is always the bottom rung, fetched by
`import()` at the moment of need.

- Platform APIs on the ladder are **Baseline boundary conditions, never feature-detected**: an
  `if (window.X)` branch is a forbidden fallback (P3). A deadline or `rootMargin` is a named policy
  constant on the happy path (P4), and a proportion beats a pixel count.
- `<script type="module">` is deferred by spec, so `DOMContentLoaded` is redundant and broken for
  dynamically imported modules. IIFE wrappers are obsolete.
- Islands flow through Vite: bundled, minified, tree-shaken, content-hashed into `/assets/`, dynamic
  chunks code-split automatically.
- **Entry-name invariant:** with `cssCodeSplit`, a page's CSS bundle is named after the JS entry
  chunk that pulls it in, so the tree-wide loader entry must carry the root sheet's stem. The e2e
  asserts the name, so a rename fails loud.

**Case study — opt-in Web Vitals telemetry.** A derived application may add a document-scoped
telemetry island whose `mount` takes no root and whose beacon is its only output. This template does
not ship it or the `web-vitals` dependency.

- **Rung:** idle, with a named deadline constant. Idle periods exist only while frames are produced,
  so a quiescent static page can starve an undeadlined callback.
- **State owner:** the batch queue belongs to the mount, not to a module singleton.
- **The heavy module rides a dynamic `import()`.** web-vitals' buffered observers replay
  pre-registration entries, so deferral is the library's intended mode.
- **One flush point:** `visibilitychange`→hidden, via `sendBeacon`, one beacon per page view. The
  unloading steps fire `visibilitychange` after `pagehide`, so a `pagehide` backstop would run
  _before_ web-vitals' finalizers and split the batch in two.
- **Ordering is by event target, not registration order.** The flush listens on `window`, which a
  bubbling `visibilitychange` reaches only after the `document` listeners web-vitals installs. So it
  registers _before_ the dynamic import resolves, closing the window in which a view ending during
  the chunk fetch would report nothing.
- Event-driven throughout (**A1**), with one named terminal catch: best-effort telemetry has no
  recovery.

Two constraints apply if that case study is adopted:

- **The idle rung leaves a window open.** The flush listener is registered inside `mount`, so from
  first paint until the idle callback fires — bounded by the deadline, not sooner — no listener
  exists and a view ending there reports nothing. Accept it only for non-critical telemetry, and
  witness both the empty-queue and refused-beacon branches.
- **A derived-view island parses each independent input once.** Form controls remain the
  platform-owned inputs to one pure derivation; the island does not introduce a second source of
  truth for their values or for the resulting output.

### Boundaries and communication

- **Island inputs are serializable** — `data-*` attributes or a JSON `<script>` tag, parsed
  through a schema at the island's boundary (P2). An island never scrapes another island's DOM.
- **Cross-island messaging is `CustomEvent`** on a shared target. No store libraries, no
  `globalThis` writes, no shared mutable module singletons — state has one owner inside the
  island (**A3**).
- **Island modules are tree-scoped** — beside their page, importing only up or in, with shared
  code at the lowest common ancestor (**A4**).
- **Deferred server-rendered regions are fragments**, not islands. When tempted, write §3.

### The island is a coalgebra (**A1**)

`render : X → B` is the observation map — the DOM is _observed from_ state, never accumulated by
scattered mutations. `step : X × E → X` is the transition structure — pure, total over a closed
event set. Together, `X → B × X^E`.

Three consequences:

1. **Model every _moded_ lifecycle as a state machine:** a closed tagged union (one variant per
   legal configuration, no boolean soup), a pure `step` (no DOM, no fetch, no clock), and a
   `never`-typed exhaustiveness guard so an unhandled variant fails `tsc`. The machine is earned
   by genuine modes — async phases, multi-step flows, data with no DOM home.
2. **A derived view needs no machine.** When the platform already owns the inputs (form fields),
   the coalgebra collapses to its observation map: a pure derivation plus `render`, no state
   object, no event set. Reifying "events" into tags each call site already knows, for a `step`
   switch to decode again, is a manufactured union — one function per case instead. A form-derived
   calculator is the simplest instance: one pure derivation over its inputs, with every listener
   using the same `render`.
3. **Bisimulation is behavioral equality**, so specs observe and never reach inside, and every
   `step` gets a model-based property spec driving generated command sequences against a model.

### Discipline inside an island

1. **One `render` fold** writes the DOM from the canonical state — the state object, or the
   platform-owned inputs a derived view reads. Effects live in the shell, feed results back as
   events, and never branch the DOM elsewhere (**A2**).
2. **Parse at the boundary** — responses and user input go through schema parsers that throw
   descriptive errors (`boundary.mjs`); past them, code trusts its types. Any boundary regex is a
   named module-scope constant with `// PROOF:`.
3. **One catch boundary** — throw at the point of failure, catch once in the shell, fold into an
   explicit error state with a named recovery transition (**A2**).
4. **One exported `mount(root)`, effect-free module body.** No `DOMContentLoaded`, no IIFEs, no
   init guards.
5. **Structural cleanup** — every listener joins one `AbortController` (`{ signal }`) and `mount`
   returns the teardown that aborts it (**A3**).
6. **Script never touches geometry** (**A3**) — it may write a custom property the sheet
   consumes; it may never read resolved geometry or write a size or position.

### Styling

Hand-written CSS in `src/assets/css/`: one sheet per subtree, named for it, **`@scope`-scoped**,
linked by that subtree's layout — so a page is never delivered styles its subtree does not use.

- Use `@scope` directly, including
  `@scope (root) { :scope { … } }` to style the scope root, so no component class escapes into the
  global namespace.
- The root sheet holds the tree-wide `:root` tokens, the base reset, and the `@scope`'d root chrome.
- Cascade layers order the reset beneath components. They complement `@scope`; they do not replace it.
- `@scope` does not cross a shadow boundary — a cost of scoped light-DOM styling over shadow DOM,
  accepted because form participation and accessibility stay native.
- Sibling subtrees may repeat small primitives, in their sheets and in their njk renderers. That is
  the price of per-subtree scoping and deletability: unscoped CSS is shared mutable state (**A3**),
  and delivery that follows the tree keeps each page's payload proportional to its subtree.

---

## §5 — Serving

When `/api` routes exist they take precedence; one static fallback service serves the built tree
(tower-http `ServeDir` mounted as the router's fallback, rooted at `--templates-dir`). The baseline
ships only `/version` plus the static fallback.

- **Security headers are set, deliberately and whole.** `Content-Security-Policy` (including
  `frame-ancestors`, the only clickjacking defense CSP uniquely provides),
  `Strict-Transport-Security` with preload, and `Cross-Origin-Opener-Policy`. These are not
  configuration restating a default — **the insecure state is the default**, so their absence is
  a decision to be insecure. The CSP is designed once, with inline-script hashes chosen
  deliberately; never piecemeal, never weakened with `unsafe-eval`.
- **Caching rides the URL.** Vite content-hashes every bundled asset into `/assets/**`, so a
  redeploy is cache-safe by URL and `immutable` would restate what the name already guarantees.
  `ServeDir` answers conditional requests with 304s. This one _is_ a default worth keeping.
- **Extension — a vitals sink.** If real-user metrics are required, they are residual server truth
  in an otherwise build-resolved site. Parse the payload at the `Json` boundary
  into a struct of native `Option<f64>` fields whose field set **is** the closed metric set
  (`deny_unknown_fields`), then through ONE consuming parse at the handler's front — non-negative,
  finite, at least one metric settled — so the logic only ever holds a report that passed (**P2**:
  parse at the boundary only; native types, no wrapper tower). Valid reports answer `204`;
  anything else is `422`.
- **Shipped access log.** A per-request `TraceLayer` span records method, path, user-agent and
  referrer; an `event = "request.serve"` response line records status and latency. The generic
  baseline derives no client IP or visitor identity.
- **Case study — log-only audience measurement.** A deployment with an explicit privacy decision
  may extend that span with direct-peer IP and a pseudonymous visitor. If adopted:
  - **Raw dimensions, read-time classification.** `user_agent` and `referer` are logged verbatim;
    nothing maps them to crawler buckets. The roster churns monthly; classify when reading.
  - **Cookieless identifiers.** One measured application uses the full hex of
    `BLAKE3_keyed(boot_key, ip ‖ user_agent)`.
    The 32-byte key is drawn from OS entropy at startup and lives only in memory, so **a restart is
    the only re-keying** and an id is stable for the process lifetime — which is what makes a
    visitor comparable across days. No clock reaches the hash, so there is no timer (**A1**).
  - **The privacy position, stated accurately: this is pseudonymization, not anonymization.** Do not
    add it to the generic baseline or assume a consent posture; record the deployment decision first.
  - **Read-time query, not a database.** Logs are emitted as structured lines and queried where
    they land (DuckDB over the JSONL, or a log store). No aggregation task, no metrics endpoint,
    no schema to migrate.
- **Compression:** on-the-fly br/gzip via a `CompressionLayer` negotiated by `Accept-Encoding`;
  incompressible types pass through. (Build-time precompression breaks extensionless files in
  tower-http and needs sibling artifacts.)
- **A real 404:** status 404 with the built `404/index.html` body, from a fixed-status handler that
  reads the page ONCE at startup. Not a static-file service under a status override
  (`SetStatus::new(ServeFile…)`), which leaks conditional/range handling onto the error path — a
  revalidating client gets an empty 304-turned-404, a Range client a truncated one. An unbuilt tree
  is a startup error naming the file; a fallback served with 200 is a soft-404.
- **Directory-index URLs** fall out of the `<dir>/index.html` shape.
- **TLS:** `rustls-acme` with TLS-ALPN-01 — the challenge rides the 443 handshake, no port-80
  sidecar — certs cached on disk, and **renewal awaited as an event stream**
  (`while let Some(ev) = state.next().await`), never a cron job. The stream ending is an error, not
  a quiet exit (**A1**, **P3**). Dev/test TLS is certgen-first: the `self-signed` build **requires**
  env vars pointing at a certgen-issued pair, and nothing is auto-generated at serve time. Local
  binds loopback with `--port 0` and logs the bound address for tests to discover.

---

## §6 — Native UX

Both of these are progressive enhancements in the P3 sense — one code path whose platform
degrades without any branch you authored. Content must never depend on them.

- `@view-transition { navigation: auto; }` — same-document view transitions are Baseline;
  **cross-document navigation transitions remain Chromium-only**, and elsewhere the platform simply
  navigates — one path, no authored branch (P3). The suite runs Chromium (§7), so the transition is
  witnessed rather than assumed.
- A speculation-rules document rule in the root layout: prefetch same-origin links at `moderate`
  eagerness, so a click paints from cache. Prefer `prefetch` over `prerender` and `moderate` over
  `eager` — speculations are real requests against your server.

**All animation is declarative CSS** — transitions, keyframes, view-transition morphs,
`details`/popover disclosure, `:hover`/`:focus-visible` affordances, scroll-driven effects. All
interruptible by the browser, all off the main thread.

A script-driven animation is admissible only when the effect is driven by client-logic state CSS
cannot observe, and even then script toggles a class or custom property and CSS animates (**A3**).
Prefer popover and invoker commands over script for menus and modals.

---

## §7 — Tests

- **E2E over real implementations.** A worker-scoped fixture starts one real backend per worker
  on an ephemeral port against throwaway state; a spec needing bespoke env spawns its own. No
  mocks. Real in-process > in-memory fake (only behind an external-IO seam) > mock (only at a
  boundary that cannot run in tests).
- **Generators for unbounded domains, exhaustive loops for enumerable sets**, composed as
  _generator outside, loop inside_: the unbounded dimension is drawn while every enumerable set the
  body touches is driven in full. An unknown path is `fc.uuid()`; the built page set, the asset set,
  the route × method grid and the schema-parsed source set are finite, so they are looped.
  - Invariants, never example tables. A regression worth capturing is folded into a generator that
    reaches its shape on every case, so the historical input is what the shrinker REPORTS rather
    than what a test states.
  - The exception is an assertion over a `static` with no input domain at all
    (`server/tests/headers.rs`), which says so in one line.
  - Run counts are overridable for fast iteration.
- **Model-based specs for every `step` (A1).** Generated command sequences against a model,
  asserting observations agree — bisimulation made executable. **Vacuous today:** the baseline
  contains no island or `step`. The obligation attaches to the first one written.
- **Multi-witness.** For a state-changing op, assert **every** source of truth it touches: the
  response, every projection, the persisted row, the log line.
- **Byte-equality is the serving-fidelity witness.** Where the claim is "the server serves this
  verbatim" — every built page, every `permalink:` artifact, the 404 body, a passthrough file —
  assert served bytes equal the built artifact. Never a copied string, never a bare 200.
- **One oracle per truth.** Glob page and asset sets from the built tree and import policy constants
  rather than copying them. An extension route may derive its closed wire field set from its own
  rejection. A copied list goes stale in the direction that matters.
- **Log-only state is witnessed from captured stdout.** Accumulate the child's stdout and wait
  **event-driven on each chunk** for the Nth occurrence — never a sleep. The negative case (a
  rejected request logs nothing) is made race-free by a flush barrier: send one more valid
  request, wait for its line, assert the count grew by exactly one.
- **Every browser page runs under a structural CDP witness.** The page fixture attaches a DevTools
  Protocol session before first navigation and asserts zero-tolerance closed sets at teardown: no
  console output of any type, no exceptions, no log entries, no DevTools issues, no dialogs or
  crashes, no prefetch failures, and same-origin traffic with a closed status set.
  - Enforcement is structural: a spec cannot opt out, and an unwitnessed extra page is itself a
    failure.
  - Only deterministic channels join the sets. Heuristic checks are excluded at the source, never
    filtered afterwards.
  - Two excused network shapes are platform semantics, not noise: a request the next navigation
    canceled, and an aborted beacon read (`sendBeacon` responses are unreadable by design; delivery
    is witnessed at the server log).
  - **CDP is Chromium's protocol, so the suite is Chromium-only.** Stated in one place —
    `playwright.config.mjs` names a single `chromium` project. A second browser would not run the
    suite twice; it would run it once without the witness. There is no cross-browser mode.
- **Mutation testing proves the suite has teeth, on every change.** `cargo-mutants` for the server,
  Stryker for JavaScript — one CI job each, downstream of `gates` in the DAG so neither burns
  runner minutes behind a failing lint. Never a `schedule:` (**A1**).
  - The baseline mutates the complete front-matter parser file and runs `tests/schema.spec.mjs`.
    An application island keeps its pure derivation in a whole-file mutation target apart from the
    browser shell; a line range would slide and score the wrong region.
  - **Browser shells stay outside that mutation scope, stated rather than implied.** Stryker's
    sandbox is built from tracked files while the served build is ignored, so a browser spec would
    otherwise execute the unmutated bundle. Cover shell branches with direct assertions and watch
    each claimed witness fail under a hand-written mutation.
- **The negative control is the stricter complement.** Drive one instance of EVERY defect class a
  witness can report and assert it catches exactly those — it is the only thing that checks the
  _witnesses_ work rather than the code.
  - Where a control table enumerates a witness's defect classes, its size is DERIVED from the
    witness's own assertion count, so an assertion added without a row fails.
  - Where the browser cannot produce a class — the site's own CSP blocks every cross-origin request
    before a response exists — the control drives the pure verdict in process, and the suite asserts
    the union of both covers the closed set of kinds.
  - A verdict whose INPUT the browser will not produce is witnessed in process or deleted. It is
    never left with a comment.
- **Ordering is part of the harness contract, and it governs BOTH suites.** `server/tests/router.rs`
  drives the real router against the built tree, so `cargo test` needs it exactly as `npm test`
  does — one ordering, not two:

```sh
npm run build && cargo build --release -p server --features self-signed && cargo test --workspace && npm test
```

- Test code is exempt from A2's strict error handling; keep it direct.

---

## §8 — Gates (run after every slice)

Code is not done until all relevant gates pass. Do not claim a check that was not run. The frontend
build comes first because the Rust router tests read the built tree.

```sh
npm run build \
  && cargo fmt --all --check \
  && npx --yes oxfmt --check \
  && npx --yes oxlint \
  && npx -p typescript tsc --project jsconfig.json \
  && npx --yes -p @ast-grep/cli ast-grep scan -r contract.yaml . \
  && cargo clippy --workspace --all-targets --all-features -- -D warnings \
  && cargo clippy --workspace --all-targets --features self-signed -- -D warnings \
  && cargo test --workspace \
  && cargo test --workspace --features acme \
  && cargo test --workspace --features self-signed
```

**Two clippy lines and three `cargo test`s, because `--all-features` is not a superset.**
Feature-gated code written `all(feature = "a", not(feature = "b"))` — the shape §5's TLS modes take,
so `acme` wins cleanly over `self-signed` — is precisely what `--all-features` turns off. The second
line lints what the e2e suite runs against. Any future mutually-exclusive pair needs its own line.

**`contract.yaml` is where the contract stops being prose.** One ast-grep file holding every
AGENTS.md check statable without false positives: a regex outside the central module (P2),
feature-detect branches (P3), `setInterval` (A1), empty catches (A2), geometry reads in island
source (A3), `globalThis`/`window` writes (A4).

It records what it leaves elsewhere too: CSS goes to the built-stylesheet spec, since ast-grep has
no CSS parser and reading BUILT bytes is stronger.

**After `npm ci`, every gate above runs through `npm`, `npx`, or `cargo`** — that is why it is one
pasteable chain. A tool needing `cargo install` or its own config file keeps its gate but takes a CI
job instead, which is mutation testing's case. `cargo semver-checks` stays on-demand: with every
crate `publish = false`, it has nothing to report yet.

**CI jobs form a DAG**, so a failure stops what depends on it: `gates` fans out to
`mutation-server`, `mutation-island` and `e2e`; `lighthouse` needs all three. `e2e` does not wait on
mutation — the `gates` edge already prevents every wasted run, and cargo-mutants is the slowest job
and the least likely to fail. Production image construction belongs to the manually dispatched
deploy runner, because CI runners have no host-control socket.

**The tsc project covers everything hand-written** — islands, tests, Eleventy data files and both
tool configs — with `checkJs`, `strict` and `maxNodeModuleJsDepth: 0`.

- One glob, `**/*.mjs`, because every hand-written file is `.mjs` — including both Eleventy data
  files and both tool configs. `exclude` then names only what is GENERATED, and `target` is not
  optional there: `cargo semver-checks` leaves a whole repo copy under it.
- Verify with `tsc --listFiles | grep -v node_modules`, not by reading the globs.
- `maxNodeModuleJsDepth: 0` is load-bearing: jsconfig implies depth 2, an editor heuristic that
  crawls and type-checks untyped vendor source. At 0, type information enters only through
  declaration files.
- `--noEmit` is absent from the command on purpose. jsconfig sets it, so the flag would restate a
  default — and its absence there would let a bare `tsc -p jsconfig.json` emit into the source tree.
- Per untyped dependency: `@types/*` where they exist, otherwise a self-destructing
  `// @ts-expect-error` with its reason on the single import line. Never a stub `.d.ts`.

Then the e2e suite (§7 ordering), then the **performance and trust gate**:

```sh
npx --yes -p @unlighthouse/cli unlighthouse-ci \
  --site "$SITE" --disable-dynamic-sampling --budget "$LIGHTHOUSE_BUDGET"
```

Four commitments:

- **A budget that is measured, not hoped for.** `LIGHTHOUSE_BUDGET` is bound and justified in the
  CI job that consumes it. Raise the sample count if CI proves noisy; never lower the budget to pass.
- **One flag, no config file.** This Lighthouse build exposes no budget flag for a file to feed, so
  declaring one would be dead wiring that reads like a gate. The category budget is the whole gate.
  If a config file is ever reintroduced: **`--config-file`, never `--config`** — the latter is
  accepted and silently ignored, auditing with defaults while the log looks healthy.
- **Trust-and-safety audits require the §5 headers.** Lighthouse checks for a strong CSP and HSTS,
  so a design shipping neither cannot pass. The causation runs that way round: the gate is right, so
  the headers ship.
- **No dynamic sampling.** Unlighthouse samples similar routes by default, and a page that is not
  audited is not gated. The page set is finite, so it is scanned in full. Coverage rests on a chain
  the suite proves: the e2e's link closure equals the built page set, and the scan audits that
  closure. The shipped error document is outside that closure by construction and the e2e witnesses
  it; an extension form confirmation joins that mechanism-reached set.
- **Audit the plain-HTTP localhost build.** A self-signed cert would fail audits for reasons that
  are not the site's; Lighthouse allowlists `localhost`. Keep default throttling — throttled mobile
  is the number real visitors get.

Reports stay gitignored; CI uploads only the small result JSON, not the screenshot bundle.

If a gate fails, fix the **cause**. Do not widen a type, suppress a lint, or weaken an assertion.

---

## The feature loop

- **New prose page** → a directory under `src/` with one `index.md`; the nearest `page.njk` renders
  it and the schema validates it. If a collection exists, front matter opts into it.
- **New server-truth operation** → a `routes/<resource>.rs` handler returning `Result<_, Error>` with
  one consuming boundary parse and witnesses for every effect.
- **New server-rendered HTML fragment** → additionally add an Askama template in
  `web/public/fragments/` and an htmx attribute on the page. If it wants chrome, it is a build-time
  page instead: put it in `web/src/` and redirect to it.
- **New client-truth behavior** → extend the island: a new _mode_ earns a state variant and a
  transition; a new _derived output_ earns only a pure derivation and `render`; a parser for any
  new boundary data. If it is a computation, offload it (§0) before adding an endpoint for it.
- **Every change** → a test at the same observable boundary, then §8.

When unsure, find the analogous shape above and match it: the skeleton, the tables and the code
shapes here are the reference.
