ARG FEATURES=

# Keep image and developer builds on the same Node version.
FROM node:26.5.0-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci
COPY web ./web
RUN npm run build

FROM rust:1.97.1-alpine3.21 AS base
RUN apk add --no-cache build-base cmake
WORKDIR /app
COPY rust-toolchain.toml ./
RUN cargo install cargo-chef --locked

# Keep Rust layers independent of web-only edits.
FROM base AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY server server
RUN cargo chef prepare --recipe-path recipe.json

FROM base AS builder
ARG FEATURES
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release ${FEATURES} -p server --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY server server
RUN cargo build --release ${FEATURES} -p server --bin server

FROM alpine:3.21 AS runtime
# Preserve the default relative template path.
WORKDIR /srv
COPY --from=builder /app/target/release/server /usr/local/bin/server
COPY --from=web /app/server/templates /srv/server/templates
ENV APP_PORT=8443

RUN mkdir -p /certs
ENTRYPOINT [ "/usr/local/bin/server" ]
