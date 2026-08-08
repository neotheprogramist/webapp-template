use std::{path::PathBuf, time::Duration};

use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::{compression::CompressionLayer, services::ServeDir, trace::TraceLayer};
use tracing::{Span, info, info_span};

use crate::{error::Error, headers, routes::version};

pub const NOT_FOUND_CONTENT_TYPE: &str = "text/html; charset=utf-8";

pub struct App(Router);

impl App {
    pub fn into_inner(self) -> Router {
        self.0
    }
}

pub async fn app(templates_dir: PathBuf) -> Result<App, Error> {
    Ok(App(headers::apply(routes(templates_dir).await?)))
}

async fn routes(templates_dir: PathBuf) -> Result<Router, Error> {
    // A fixed-status handler, not a ServeFile under SetStatus: a static service would leak its
    // conditional/range handling onto the error path — an empty 304-turned-404, a truncated Range.
    // Read once at startup, so the handler is total and an unbuilt tree is a startup error.
    let not_found_body = read_not_found_page(&templates_dir).await?;
    let not_found = Router::new().fallback(move || {
        let body = not_found_body.clone();
        async move {
            (
                StatusCode::NOT_FOUND,
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(NOT_FOUND_CONTENT_TYPE),
                )],
                body,
            )
                .into_response()
        }
    });

    Ok(Router::new()
        .route("/version", get(version::report))
        .fallback_service(ServeDir::new(templates_dir).not_found_service(not_found))
        .layer(CompressionLayer::new())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request| {
                    let read_header = |name: header::HeaderName| {
                        request
                            .headers()
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                    };
                    info_span!(
                        "request",
                        method = %request.method(),
                        path = %request.uri().path(),
                        user_agent = read_header(header::USER_AGENT),
                        referer = read_header(header::REFERER),
                    )
                })
                .on_response(|response: &Response, latency: Duration, _span: &Span| {
                    info!(
                        event = "request.serve",
                        status = response.status().as_u16(),
                        latency_ms = %latency.as_millis(),
                    );
                }),
        ))
}

/// Attaches path context that `From` cannot supply.
async fn read_not_found_page(templates_dir: &std::path::Path) -> Result<Vec<u8>, Error> {
    let path = templates_dir.join("404/index.html");
    tokio::fs::read(&path)
        .await
        .map_err(|source| Error::NotFoundPage { path, source })
}
