#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

use std::collections::{BTreeMap, BTreeSet};

use axum::http::HeaderName;
use server::{
    headers::{NAMES, declared},
    policy::{
        CONTENT_SECURITY_POLICY, CROSS_ORIGIN_OPENER_POLICY, HSTS_PRELOAD_MIN_MAX_AGE,
        STRICT_TRANSPORT_SECURITY,
    },
};

fn declared_text() -> impl Iterator<Item = (&'static str, &'static str)> {
    declared().map(|(name, value)| {
        (
            name.as_str(),
            value.to_str().expect("header value is ASCII"),
        )
    })
}

fn value_of(name: &str) -> &'static str {
    declared_text()
        .find(|(header, _)| *header == name)
        .unwrap_or_else(|| panic!("the header set declares {name}"))
        .1
}

fn csp() -> BTreeMap<&'static str, Vec<&'static str>> {
    value_of(NAMES[0].as_str())
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut words = part.split_whitespace();
            (words.next().unwrap_or_default(), words.collect())
        })
        .collect()
}

const REQUIRED_CSP_DIRECTIVES: [&str; 6] = [
    "base-uri",
    "default-src",
    "form-action",
    "frame-ancestors",
    "object-src",
    "script-src",
];

const CLOSED_CSP_DIRECTIVES: [&str; 3] = ["frame-ancestors", "base-uri", "object-src"];

const ADMISSIBLE_SOURCES: [&str; 3] = ["'self'", "'none'", "'inline-speculation-rules'"];

const SPECULATION_RULES: &str = "'inline-speculation-rules'";

#[test]
fn the_declared_set_is_exactly_the_three_policy_constants() {
    let values = [
        CONTENT_SECURITY_POLICY,
        STRICT_TRANSPORT_SECURITY,
        CROSS_ORIGIN_OPENER_POLICY,
    ];
    let names: Vec<_> = declared_text().map(|(name, _)| name).collect();
    assert_eq!(
        names,
        NAMES.each_ref().map(HeaderName::as_str),
        "three headers are declared; a fourth is welcome but must be a deliberate edit"
    );
    for (name, declared_value) in NAMES.iter().zip(values) {
        assert_eq!(
            value_of(name.as_str()),
            declared_value,
            "{name} carries its constant"
        );
    }
    for (name, value) in declared_text() {
        assert!(!value.is_empty(), "{name} carries a value");
        assert!(
            value.chars().all(|c| c == '\t' || (' '..='~').contains(&c)),
            "{name} is visible US-ASCII, the HeaderValue grammar: {value:?}"
        );
    }
}

#[test]
fn the_csp_is_exactly_the_required_directives_over_admissible_sources() {
    let csp = csp();
    assert_eq!(
        csp.keys().copied().collect::<BTreeSet<_>>(),
        BTreeSet::from(REQUIRED_CSP_DIRECTIVES),
        "a directive dropped and a directive added both fail here"
    );
    for (directive, sources) in &csp {
        assert!(!sources.is_empty(), "{directive} names at least one source");
        for source in sources {
            assert!(
                ADMISSIBLE_SOURCES.contains(source),
                "{directive} names {source}, which no directive may"
            );
        }
        // The root layout's speculation-rules block is inline and governed by script-src, so the
        // keyword has to be there — and nowhere else, or the admission is wider than its one need.
        assert_eq!(
            sources.contains(&SPECULATION_RULES),
            *directive == "script-src",
            "{directive} admits speculation rules exactly when it is script-src"
        );
    }
    for closed in CLOSED_CSP_DIRECTIVES {
        assert!(
            REQUIRED_CSP_DIRECTIVES.contains(&closed),
            "{closed} is one of the required directives"
        );
        assert_eq!(
            csp.get(closed).map(Vec::as_slice),
            Some(["'none'"].as_slice()),
            "{closed} is closed to everything"
        );
    }
}

#[test]
fn hsts_clears_the_preload_minimum_and_claims_preload() {
    // Parsed out of the constant rather than compared to a copy, so a changed value is read
    // through the same grammar the preload list applies.
    let hsts = value_of(NAMES[1].as_str());
    let directives: Vec<_> = hsts.split(';').map(str::trim).collect();
    let max_age = directives
        .iter()
        .find_map(|part| part.strip_prefix("max-age="))
        .expect("HSTS states a max-age")
        .parse::<u64>()
        .expect("max-age is a number of seconds");
    assert!(
        max_age >= HSTS_PRELOAD_MIN_MAX_AGE,
        "max-age={max_age} clears the preload minimum {HSTS_PRELOAD_MIN_MAX_AGE}"
    );
    // The preload list rejects `preload` without `includeSubDomains`, so the pair travels together.
    for required in ["includeSubDomains", "preload"] {
        assert!(directives.contains(&required), "{hsts} states {required}");
    }
}
