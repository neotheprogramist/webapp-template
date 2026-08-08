# Webapp Template

A static-first web application scaffold: Eleventy renders a small reference site, Vite
post-processes its assets, HTML is minified, and an axum server delivers the generated files with
compression, cache validation, security headers, request tracing, optional TLS, and a `/version`
endpoint.

The checked-in site is intentionally generic. Replace its identity, content, and styles when
starting an application; retain or remove the optional server capabilities according to that
application's needs.

`AGENTS.md` is the engineering contract. `WEBAPP.md` describes the architecture. This file owns the
runnable commands.

## Prerequisites

- `mise` for the Node version pinned in `mise.toml`.
- `rustup` for stable Rust 1.97.1 and the components pinned in `rust-toolchain.toml`.

## Install and build

```bash
mise install
npm ci
npm run build
cargo build --release -p server
```

The frontend build writes the ignored `server/templates/` tree. Build it before running the server
or Rust router tests.

## Run

```bash
cargo run --release -p server
APP_PORT=8080 cargo run --release -p server
```

The default host is `::`, the default port is `0` (an ephemeral port reported in the listen log),
and the default static directory is `server/templates`. See `.env.example` or
`cargo run --release -p server -- --help` for every setting.

For frontend-only development:

```bash
npm run dev -w web
```

## Start a new application

1. Set the public name, canonical URL, language, and locale in `web/src/src.11tydata.mjs`. Keep the
   reserved `.invalid` URL until a real deployment URL is known.
2. Replace `web/src/index.njk`, `web/src/about/index.md`, the favicon, and the styles under
   `web/src/assets/css/`.
3. Add each build-time page as an `index.md` or `index.njk` file and parse its front matter through
   `web/src/content.schema.mjs`.
4. Add request-time routes only for data that cannot be bound during the frontend build. The base
   template deliberately ships no forms, analytics, identity derivation, or telemetry sinks.
5. Update package metadata, the container image tag, and deployment configuration for the new
   repository.

`web/src/sitemap.njk`, `web/src/feed.njk`, `web/src/llms.njk`, and `web/src/robots.njk` derive their
output from the built page collection; they should not become parallel route registries. Add
content-specific structured data only when the visible page supports every claimed field.

## Test

Install Chromium once, then build both sides before the browser suite:

```bash
npx playwright install chromium
npm run build
cargo build --release -p server --features self-signed
npm test
```

The Playwright suite starts the release server over HTTPS and checks the complete generated page
set, link closure, byte-identical delivery, metadata, assets, sitemap and robots output, route and
method behavior, security headers, compression, viewport containment, TLS failure modes, and the
absence of derived visitor identity in request logs.

Exercise the Rust feature variants independently:

```bash
cargo test --workspace
cargo test --workspace --features acme
cargo test --workspace --features self-signed
```

`--all-features` is not a replacement for the last two commands: ACME takes precedence when both
TLS features are enabled.

## Static checks

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo clippy --workspace --all-targets --features self-signed -- -D warnings
npx --yes oxlint
npx -p typescript tsc --project jsconfig.json
npx --yes oxfmt --check
npx --yes -p @ast-grep/cli ast-grep scan -r contract.yaml .
```

Mutation gates run separately because each needs its own installation or configuration:

```bash
cargo install cargo-mutants --locked
cargo mutants --features self-signed \
  --exclude server/src/serve.rs --exclude server/src/bin/certgen.rs \
  --exclude-re 'replace main -> Result' --exclude-re '(?i)acme'
npx --yes -p @stryker-mutator/core stryker run
```

Stryker mutates the front-matter parser and runs `tests/schema.spec.mjs`. Rust exclusions are
limited to shells and feature-disabled paths the selected test build cannot reach.

## TLS

Generate a development certificate and run the self-signed feature:

```bash
cargo run -p server --features self-signed --bin certgen -- \
  --cert certs/cert.pem --key certs/key.pem
APP_TLS_CERT=certs/cert.pem APP_TLS_KEY=certs/key.pem \
  cargo run --release -p server --features self-signed
```

For server-owned ACME, build with `--features acme` and set `APP_ACME_DOMAINS`,
`APP_ACME_EMAIL`, and `APP_CERTS_DIR`. Add `APP_ACME_PRODUCTION=true` only after staging issuance
succeeds. The certificate cache must be durable across restarts.

## Container

```bash
podman build -t webapp-template/app -f Containerfile .
podman run --rm -p '[::1]:8443:8443' webapp-template/app
```

The image serves HTTP on port 8443 by default and does not select a runtime `USER`. Select a TLS
feature and provide its configuration when the application owns TLS; otherwise terminate TLS at
the deployment boundary. A deployment may add a non-root user after it provisions writable
certificate storage for that identity.

## Deployment

CI, stage, production, and deployment verification run only on persistent self-hosted ARM64
runners. Before enabling the workflows, replace `TODO_PROJECT_RUNNER_LABEL` in `ci.yaml`,
`stage.yaml`, and `prod.yaml`, then replace `TODO_PROJECT_SLUG` and `TODO_DOMAIN` in the two
deployment workflows. Repositories using this topology must remain private because pull requests
execute arbitrary code on the CI runner.

Stage requires the dispatched commit to remain current `main` with a successful CI run, builds one
immutable version image, and moves the stage tag. Production exposes only explicit `promote` and
`rollback` transitions. Both call `verify-deployment.yaml`, which observes the immutable image,
router bind, platform network and resolver, exclusive port ownership, runner isolation, and the
expected internal DNS alias. Routed TLS, `/version`, and positive and negative public routes remain
operator observations from a host that can reach the router's fixed address.

## Graceful shutdown crate

`crates/shutdown` converts Unix SIGINT and SIGTERM into one closed `ShutdownSignal` type.
The server observes that event, stops accepting work, drains in-flight connections, and exits
cleanly. The crate is intentionally independent of axum and tracing so another workspace service
can reuse it.
