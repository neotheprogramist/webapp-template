use axum::Json;
use serde::Serialize;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Serialize)]
pub struct Version {
    version: &'static str,
}

/// Reports the binary identity, which cannot diverge from the served image.
pub async fn report() -> Json<Version> {
    Json(Version { version: VERSION })
}
