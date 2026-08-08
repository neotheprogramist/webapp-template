#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

mod common;

use axum::http::{StatusCode, header};
use common::{get, header_of, respond};

const EXPECTED: &str = env!("CARGO_PKG_VERSION");

fn assert_http_shape(status: StatusCode, content_type: Option<&str>) {
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, Some("application/json"));
}

fn assert_version_value(served: &serde_json::Value) {
    assert_eq!(
        served.get("version").and_then(serde_json::Value::as_str),
        Some(EXPECTED)
    );
}

fn assert_only_version_field(served: &serde_json::Value) {
    let fields: Vec<_> = served
        .as_object()
        .expect("a JSON object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(fields, ["version"]);
}

fn assert_release_version(version: &str) {
    let components: Vec<_> = version.split('.').collect();
    assert_eq!(components.len(), 3, "{version}");
    for component in components {
        component
            .parse::<u64>()
            .unwrap_or_else(|error| panic!("{version}: {component} is not numeric ({error})"));
    }
}

#[test]
fn version_serves_the_compiled_in_version_as_json() {
    let (status, head, body) = respond(get("/version"));

    assert_http_shape(status, header_of(&head, header::CONTENT_TYPE.as_str()));

    let served: serde_json::Value = serde_json::from_slice(&body).expect("a JSON body");
    assert_version_value(&served);
}

#[test]
fn the_body_carries_that_one_field_and_no_other() {
    let (_, _, body) = respond(get("/version"));
    let served: serde_json::Value = serde_json::from_slice(&body).expect("a JSON body");
    assert_only_version_field(&served);
}

#[test]
fn the_version_is_three_numeric_components() {
    assert_release_version(EXPECTED);
}

#[test]
fn every_version_witness_rejects_its_defect_class() {
    assert!(
        std::panic::catch_unwind(|| assert_http_shape(
            StatusCode::BAD_GATEWAY,
            Some("application/json")
        ))
        .is_err()
    );
    assert!(
        std::panic::catch_unwind(|| assert_http_shape(StatusCode::OK, Some("text/plain"))).is_err()
    );
    assert!(
        std::panic::catch_unwind(|| {
            assert_version_value(&serde_json::json!({"version": "not-the-compiled-version"}));
        })
        .is_err()
    );
    assert!(
        std::panic::catch_unwind(|| {
            assert_only_version_field(&serde_json::json!({"version": EXPECTED, "extra": true}));
        })
        .is_err()
    );
    for malformed in ["1.2", "1.two.3"] {
        assert!(
            std::panic::catch_unwind(|| assert_release_version(malformed)).is_err(),
            "{malformed}"
        );
    }
}
