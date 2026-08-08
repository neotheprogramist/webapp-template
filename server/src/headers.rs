use axum::{
    Router,
    http::{HeaderName, HeaderValue},
};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::policy::{
    CONTENT_SECURITY_POLICY, CROSS_ORIGIN_OPENER_POLICY, STRICT_TRANSPORT_SECURITY,
};

/// Static storage lets [`declared`] return references to the configured values.
pub static NAMES: [HeaderName; 3] = [
    HeaderName::from_static("content-security-policy"),
    HeaderName::from_static("strict-transport-security"),
    HeaderName::from_static("cross-origin-opener-policy"),
];

static VALUES: [HeaderValue; 3] = [
    HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    HeaderValue::from_static(STRICT_TRANSPORT_SECURITY),
    HeaderValue::from_static(CROSS_ORIGIN_OPENER_POLICY),
];

pub fn apply(router: Router) -> Router {
    declared().fold(router, |router, (name, value)| {
        router.layer(SetResponseHeaderLayer::overriding(
            name.clone(),
            value.clone(),
        ))
    })
}

pub fn declared() -> impl Iterator<Item = (&'static HeaderName, &'static HeaderValue)> {
    NAMES.iter().zip(VALUES.iter())
}
