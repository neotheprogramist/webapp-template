#![allow(
    dead_code,
    reason = "each test binary compiles all of this and uses part of it"
)]

use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use proptest::prelude::*;
use server::router::app;
use tokio::runtime::Runtime;
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

const WHITESPACE: &str = " \t\n\r\u{a0}\u{2003}";

prop_compose! {
    pub fn padding()(chars in prop::collection::vec(prop::sample::select(
        WHITESPACE.chars().collect::<Vec<_>>()), 0..8)) -> String {
        chars.into_iter().collect()
    }
}

prop_compose! {
    pub fn address_parts()(
        local in "[a-z0-9._%+-]{1,12}",
        domain in "[a-z0-9-]{1,12}",
        tld in "[a-z]{2,6}",
    ) -> (String, String, String) {
        (local, domain, tld)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Malformation {
    NoAt,
    SecondAt,
    EmptyDomainLabel,
    InteriorWhitespace,
}

pub const MALFORMATIONS: [Malformation; 4] = [
    Malformation::NoAt,
    Malformation::SecondAt,
    Malformation::EmptyDomainLabel,
    Malformation::InteriorWhitespace,
];

pub fn malformed(kind: Malformation, (local, domain, tld): &(String, String, String)) -> String {
    match kind {
        Malformation::NoAt => format!("{local}.{domain}.{tld}"),
        Malformation::SecondAt => format!("{local}@@{domain}.{tld}"),
        Malformation::EmptyDomainLabel => format!("{local}@.{tld}"),
        Malformation::InteriorWhitespace => format!("{local} {domain}@{domain}.{tld}"),
    }
}

pub const HISTORICAL_ADDRESSES: [(Malformation, &str); 3] = [
    (Malformation::SecondAt, "a@@b.co"),
    (Malformation::EmptyDomainLabel, "a@.co"),
    (Malformation::InteriorWhitespace, "a b@b.co"),
];

pub const ADVERSARIAL_LOCALS: [&str; 3] = ["-", "-a", "a-"];

pub const BOUNDARY_BLANKS: [&str; 2] = ["", " "];

pub fn expected_fields(message: &str) -> Vec<String> {
    let Some((_, named)) = message.split_once("expected one of ") else {
        return Vec::new();
    };
    let mut fields = Vec::new();
    let mut rest = named;
    while let Some((_, after)) = rest.split_once('`') {
        let Some((field, tail)) = after.split_once('`') else {
            break;
        };
        fields.push(field.to_owned());
        rest = tail;
    }
    fields
}

#[derive(Clone, Default)]
pub struct Logged(Arc<Mutex<Vec<String>>>);

impl Logged {
    pub fn take_containing(&self, needle: &str) -> Vec<String> {
        let mut buffer = self.0.lock().expect("the log buffer is not poisoned");
        let (mine, rest) = std::mem::take(&mut *buffer)
            .into_iter()
            .partition(|line| line.contains(needle));
        *buffer = rest;
        mine
    }
}

impl io::Write for Logged {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf).into_owned();
        self.0
            .lock()
            .expect("the log buffer is not poisoned")
            .extend(text.lines().map(str::to_owned));
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Logged {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

static LOGGED: LazyLock<Logged> = LazyLock::new(|| {
    let sink = Logged::default();
    // GLOBAL, not thread-local: the router runs on tokio worker threads.
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .without_time()
            .with_writer(sink.clone())
            .finish(),
    )
    .expect("no other subscriber is installed in this test binary");
    sink
});

pub fn logged() -> &'static Logged {
    &LOGGED
}

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| Runtime::new().expect("the runtime starts"));

static ROUTER: LazyLock<axum::Router> = LazyLock::new(|| {
    RUNTIME
        .block_on(app(templates_dir()))
        .expect("the built tree carries a 404 page")
        .into_inner()
});

pub fn templates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("templates")
}

pub fn built(relative: &str) -> Vec<u8> {
    std::fs::read(templates_dir().join(relative)).unwrap_or_else(|error| {
        panic!("run `npm run build` before `cargo test`: {relative} is missing ({error})")
    })
}

pub type Served = (StatusCode, Vec<(String, String)>, Vec<u8>);

pub fn respond(request: Request<Body>) -> Served {
    // Installed before the first request, or every log assertion passes vacuously on an empty buffer.
    logged();

    // Forced outside `block_on`: building the router awaits, and a nested `block_on` panics.
    let router = ROUTER.clone();
    RUNTIME.block_on(async move {
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let head = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, head, body.to_vec())
    })
}

pub fn get(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
}

pub fn header_of<'a>(head: &'a [(String, String)], name: &str) -> Option<&'a str> {
    head.iter()
        .find(|(served, _)| served == name)
        .map(|(_, value)| value.as_str())
}

/// Policy: keep real routed properties fast under mutation testing.
/// `APP_TEST_CASES` raises the run count; a non-positive value fails loudly.
pub fn http_cases() -> u32 {
    let Ok(raw) = std::env::var("APP_TEST_CASES") else {
        return 32;
    };
    match raw.parse::<u32>() {
        Ok(cases) if cases > 0 => cases,
        _ => panic!("APP_TEST_CASES must be a positive integer, got {raw:?}"),
    }
}

pub fn http_config() -> ProptestConfig {
    ProptestConfig {
        cases: http_cases(),
        ..ProptestConfig::default()
    }
}

static REQUESTS: AtomicU64 = AtomicU64::new(0);

pub fn token() -> String {
    format!("witness-{}-", REQUESTS.fetch_add(1, Ordering::Relaxed))
}

pub fn respond_tagged(token: &str, request: Request<Body>) -> Served {
    let mut request = request;
    request
        .headers_mut()
        .insert(header::USER_AGENT, token.parse().expect("a header value"));
    respond(request)
}

pub fn lines_for(token: &str) -> Vec<String> {
    logged().take_containing(token)
}

pub fn one_line(token: &str, event: &str) -> String {
    let marker = format!("event=\"{event}\"");
    let lines: Vec<_> = lines_for(token)
        .into_iter()
        .filter(|line| line.contains(&marker))
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "exactly one {event} line for {token}: {lines:?}"
    );
    lines.into_iter().next().unwrap()
}
