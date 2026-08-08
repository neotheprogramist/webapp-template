use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid RUST_LOG")]
    LogFilter(#[from] tracing_subscriber::filter::FromEnvError),

    #[error(transparent)]
    ShutdownSignal(#[from] shutdown::Error),

    #[error("failed to signal readiness to the service manager")]
    Readiness(#[source] std::io::Error),

    #[error("no 404 page under the templates dir: {path} — run `npm run build` first")]
    NotFoundPage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[cfg(all(feature = "self-signed", not(feature = "acme")))]
    #[error("invalid TLS PEM: {path} — run certgen first (README \"TLS modes\")")]
    TlsPem {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Renewal cannot continue after the ACME stream ends.
    #[cfg(feature = "acme")]
    #[error("ACME certificate event stream ended — renewal is no longer possible")]
    AcmeEvents,

    #[cfg(feature = "acme")]
    #[error("fatal ACME certificate lifecycle error: {0}")]
    Acme(#[source] Box<rustls_acme::EventError<std::io::Error, std::io::Error>>),
}
