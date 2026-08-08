use std::future::Future;

#[cfg(not(any(feature = "self-signed", feature = "acme")))]
pub use plain::serve;
#[cfg(any(feature = "self-signed", feature = "acme"))]
pub use tls::serve;

use crate::{config::Config, error::Error};

fn shutdown_signal() -> Result<impl Future<Output = ()>, Error> {
    let shutdown = shutdown::listen()?;
    Ok(async move {
        let signal = shutdown.await;
        tracing::info!(event = "server.shutdown", ?signal);
    })
}

async fn bind(cfg: &Config) -> Result<tokio::net::TcpListener, Error> {
    let listener = tokio::net::TcpListener::bind(cfg.addr()).await?;
    tracing::info!(event = "server.listen", addr = %listener.local_addr()?);
    Ok(listener)
}

/// Signals only after all serving prerequisites are ready and attaches operation context.
fn notify_ready() -> Result<(), Error> {
    sd_notify::notify(&[sd_notify::NotifyState::Ready]).map_err(Error::Readiness)
}

#[cfg(not(any(feature = "self-signed", feature = "acme")))]
mod plain {
    use crate::{config::Config, error::Error, router::App};

    pub async fn serve(app: App, cfg: &Config) -> Result<(), Error> {
        let shutdown = super::shutdown_signal()?;
        let listener = super::bind(cfg).await?;
        super::notify_ready()?;
        axum::serve(listener, app.into_inner())
            .with_graceful_shutdown(shutdown)
            .await?;
        Ok(())
    }
}

#[cfg(any(feature = "self-signed", feature = "acme"))]
mod tls {
    use std::{future::Future, net::SocketAddr, sync::Arc};

    use axum::Router;
    use futures_util::stream::{FuturesUnordered, StreamExt};
    use hyper_util::{
        rt::{TokioExecutor, TokioIo},
        server::graceful::{GracefulShutdown, Watcher},
        service::TowerToHyperService,
    };
    use tokio::net::{TcpListener, TcpStream};
    use tokio_rustls::{
        rustls::{self, ServerConfig},
        server::TlsStream,
    };

    use crate::{config::Config, error::Error, router::App};

    /// Structural protocol set served by hyper's auto builder.
    const ALPN_PROTOCOLS: [&[u8]; 2] = [b"h2", b"http/1.1"];

    fn with_http_alpn(mut config: ServerConfig) -> Arc<ServerConfig> {
        config.alpn_protocols = ALPN_PROTOCOLS.iter().map(|name| name.to_vec()).collect();
        Arc::new(config)
    }

    fn ensure_crypto_provider() {
        let already_installed = rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .is_err();
        tracing::debug!(event = "tls.provider", already_installed);
    }

    #[cfg(not(feature = "acme"))]
    type Acceptor = tokio_rustls::TlsAcceptor;

    #[cfg(feature = "acme")]
    #[derive(Clone)]
    struct Acceptor {
        challenge: Arc<ServerConfig>,
        default: Arc<ServerConfig>,
    }

    /// Attaches the PEM path context that `From` cannot supply.
    #[cfg(not(feature = "acme"))]
    async fn read_pem(path: std::path::PathBuf) -> Result<Vec<u8>, Error> {
        tokio::fs::read(&path)
            .await
            .map_err(|source| Error::TlsPem { path, source })
    }

    #[cfg(not(feature = "acme"))]
    fn malformed_pem(path: &std::path::Path, detail: impl ToString) -> Error {
        Error::TlsPem {
            path: path.to_owned(),
            source: std::io::Error::other(detail.to_string()),
        }
    }

    #[cfg(not(feature = "acme"))]
    async fn acceptor(cfg: &Config) -> Result<Acceptor, Error> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};

        let cert = read_pem(cfg.tls_cert().to_owned()).await?;
        let key = read_pem(cfg.tls_key().to_owned()).await?;

        let chain = CertificateDer::pem_slice_iter(&cert)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| malformed_pem(cfg.tls_cert(), error))?;
        let key = PrivateKeyDer::from_pem_slice(&key)
            .map_err(|error| malformed_pem(cfg.tls_key(), error))?;
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .map_err(|error| malformed_pem(cfg.tls_cert(), error))?;

        Ok(tokio_rustls::TlsAcceptor::from(with_http_alpn(config)))
    }

    #[cfg(feature = "acme")]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CertificateState {
        Awaiting,
        Ready,
    }

    #[cfg(feature = "acme")]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CertificateEffect {
        None,
        NotifyReady,
    }

    #[cfg(feature = "acme")]
    fn step_certificate(
        state: CertificateState,
        event: &rustls_acme::EventOk,
    ) -> (CertificateState, CertificateEffect) {
        use rustls_acme::EventOk;

        match (state, event) {
            (
                CertificateState::Awaiting,
                EventOk::DeployedCachedCert | EventOk::DeployedNewCert,
            ) => (CertificateState::Ready, CertificateEffect::NotifyReady),
            (CertificateState::Ready, EventOk::DeployedCachedCert | EventOk::DeployedNewCert)
            | (CertificateState::Awaiting, EventOk::CertCacheStore | EventOk::AccountCacheStore)
            | (CertificateState::Ready, EventOk::CertCacheStore | EventOk::AccountCacheStore) => {
                (state, CertificateEffect::None)
            }
        }
    }

    #[cfg(feature = "acme")]
    fn handle_acme_error(
        error: rustls_acme::EventError<std::io::Error, std::io::Error>,
    ) -> Result<(), Error> {
        use rustls_acme::{EventError, OrderError, acme::AcmeError};

        match error {
            error @ EventError::Order(OrderError::Acme(
                AcmeError::Io(_) | AcmeError::HttpRequest(_),
            ))
            | error @ EventError::Order(
                OrderError::TooManyAttemptsAuth(_) | OrderError::ProcessingTimeout(_),
            ) => {
                tracing::error!(event = "tls.cert.transient", error = ?error);
                Ok(())
            }
            error @ (EventError::CertCacheLoad(_)
            | EventError::AccountCacheLoad(_)
            | EventError::CertCacheStore(_)
            | EventError::AccountCacheStore(_)
            | EventError::CachedCertParse(_)
            | EventError::NewCertParse(_)
            | EventError::Order(OrderError::Rcgen(_))
            | EventError::Order(OrderError::BadOrder(_))
            | EventError::Order(OrderError::BadAuth(_))
            | EventError::Order(OrderError::Acme(
                AcmeError::Rcgen(_)
                | AcmeError::Jose(_)
                | AcmeError::Json(_)
                | AcmeError::HttpResponseNonStringHeader(_)
                | AcmeError::KeyRejected(_)
                | AcmeError::Crypto(_)
                | AcmeError::MissingHeader(_)
                | AcmeError::NoTlsAlpn01Challenge
                | AcmeError::NoHttp01Challenge,
            ))) => Err(Error::Acme(Box::new(error))),
        }
    }

    #[cfg(feature = "acme")]
    type AcmeState = rustls_acme::AcmeState<std::io::Error, std::io::Error>;

    #[cfg(feature = "acme")]
    fn acme_state(cfg: &Config) -> AcmeState {
        let acme = cfg.acme();
        rustls_acme::AcmeConfig::new(acme.domains())
            .contact([format!("mailto:{}", acme.email().as_str())])
            .cache(rustls_acme::caches::DirCache::new(
                acme.certs_dir().to_path_buf(),
            ))
            .directory_lets_encrypt(acme.production())
            .state()
    }

    #[cfg(feature = "acme")]
    fn acme_acceptor(state: &AcmeState) -> Acceptor {
        // default_rustls_config omits ALPN, so build from the resolver.
        let serving = ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(state.resolver());

        Acceptor {
            challenge: state.challenge_rustls_config(),
            default: with_http_alpn(serving),
        }
    }

    #[cfg(feature = "acme")]
    async fn drive_certificates(mut state: AcmeState) -> Error {
        let mut certificate = CertificateState::Awaiting;
        while let Some(event) = state.next().await {
            match event {
                Ok(ok) => {
                    tracing::info!(event = "tls.cert", detail = ?ok);
                    let (next, effect) = step_certificate(certificate, &ok);
                    certificate = next;
                    match effect {
                        CertificateEffect::None => {}
                        CertificateEffect::NotifyReady => {
                            if let Err(error) = super::notify_ready() {
                                return error;
                            }
                        }
                    }
                }
                Err(error) => {
                    if let Err(error) = handle_acme_error(error) {
                        return error;
                    }
                }
            }
        }
        Error::AcmeEvents
    }

    #[cfg(not(feature = "acme"))]
    async fn handshake(
        acceptor: &Acceptor,
        stream: TcpStream,
    ) -> std::io::Result<Option<TlsStream<TcpStream>>> {
        acceptor.accept(stream).await.map(Some)
    }

    #[cfg(feature = "acme")]
    async fn handshake(
        acceptor: &Acceptor,
        stream: TcpStream,
    ) -> std::io::Result<Option<TlsStream<TcpStream>>> {
        use tokio::io::AsyncWriteExt;

        let start = tokio_rustls::LazyConfigAcceptor::new(Default::default(), stream).await?;
        if rustls_acme::is_tls_alpn_challenge(&start.client_hello()) {
            tracing::info!(event = "tls.challenge");
            start
                .into_stream(acceptor.challenge.clone())
                .await?
                .shutdown()
                .await?;
            return Ok(None);
        }
        start.into_stream(acceptor.default.clone()).await.map(Some)
    }

    pub async fn serve(app: App, cfg: &Config) -> Result<(), Error> {
        ensure_crypto_provider();

        #[cfg(feature = "acme")]
        let state = acme_state(cfg);
        #[cfg(feature = "acme")]
        let acceptor = acme_acceptor(&state);
        #[cfg(not(feature = "acme"))]
        let acceptor = acceptor(cfg).await?;

        let shutdown = super::shutdown_signal()?;
        let listener = super::bind(cfg).await?;
        // ACME readiness waits for its first certificate in the driver.
        #[cfg(not(feature = "acme"))]
        super::notify_ready()?;

        #[cfg(feature = "acme")]
        let termination = async {
            tokio::select! {
                () = shutdown => Ok(()),
                error = drive_certificates(state) => Err(error),
            }
        };
        #[cfg(not(feature = "acme"))]
        let termination = async {
            shutdown.await;
            Ok(())
        };

        serve_tls(listener, app.into_inner(), acceptor, termination).await
    }

    #[cfg(all(test, feature = "acme"))]
    mod tests {
        use rustls_acme::{EventError, EventOk, OrderError, acme::AcmeError};

        use super::{CertificateEffect, CertificateState, handle_acme_error, step_certificate};

        #[test]
        fn readiness_follows_only_a_deployed_certificate_and_only_once() {
            let states = [CertificateState::Awaiting, CertificateState::Ready];
            let events = [
                EventOk::DeployedCachedCert,
                EventOk::DeployedNewCert,
                EventOk::CertCacheStore,
                EventOk::AccountCacheStore,
            ];

            for state in states {
                for event in &events {
                    let deployed = matches!(
                        event,
                        EventOk::DeployedCachedCert | EventOk::DeployedNewCert
                    );
                    let next = if state == CertificateState::Ready || deployed {
                        CertificateState::Ready
                    } else {
                        CertificateState::Awaiting
                    };
                    let effect = if state == CertificateState::Awaiting && deployed {
                        CertificateEffect::NotifyReady
                    } else {
                        CertificateEffect::None
                    };

                    assert_eq!(step_certificate(state, event), (next, effect));
                }
            }
        }

        #[test]
        fn cache_failures_are_fatal_and_network_failures_retain_crate_backoff() {
            let cache = EventError::AccountCacheStore(std::io::Error::other("control"));
            assert!(handle_acme_error(cache).is_err());

            let network = EventError::Order(OrderError::Acme(AcmeError::Io(
                std::io::Error::other("control"),
            )));
            assert!(handle_acme_error(network).is_ok());
        }
    }

    fn is_connection_error(error: &std::io::Error) -> bool {
        matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionRefused
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::ConnectionReset
        )
    }

    async fn accept_connection(listener: &TcpListener) -> (TcpStream, SocketAddr) {
        loop {
            match listener.accept().await {
                Ok(accepted) => return accepted,
                // Retry listener resource exhaustion; discard one peer's teardown.
                Err(error) if is_connection_error(&error) => {}
                Err(error) => {
                    tracing::error!(event = "server.accept.error", %error);
                    tokio::time::sleep(crate::policy::ACCEPT_RETRY_DELAY).await;
                }
            }
        }
    }

    async fn serve_connection(
        router: Router,
        acceptor: Acceptor,
        watcher: Watcher,
        stream: TcpStream,
        peer: SocketAddr,
    ) {
        // Bound silent peers without terminating the listener.
        let handshake = tokio::time::timeout(
            crate::policy::TLS_HANDSHAKE_TIMEOUT,
            handshake(&acceptor, stream),
        );
        let stream = match handshake.await {
            Ok(Ok(Some(stream))) => stream,
            Ok(Ok(None)) => return,
            Ok(Err(error)) => {
                tracing::debug!(event = "tls.handshake.error", %peer, %error);
                return;
            }
            Err(_elapsed) => {
                tracing::debug!(event = "tls.handshake.timeout", %peer);
                return;
            }
        };
        let service = TowerToHyperService::new(router);
        let builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
        let connection = builder.serve_connection_with_upgrades(TokioIo::new(stream), service);
        if let Err(error) = watcher.watch(connection.into_owned()).await {
            tracing::debug!(event = "server.connection.error", %peer, %error);
        }
    }

    async fn serve_tls(
        listener: TcpListener,
        router: Router,
        acceptor: Acceptor,
        termination: impl Future<Output = Result<(), Error>>,
    ) -> Result<(), Error> {
        let graceful = GracefulShutdown::new();
        let mut connections = FuturesUnordered::new();
        tokio::pin!(termination);

        let outcome = loop {
            tokio::select! {
                (stream, peer) = accept_connection(&listener) => {
                    connections.push(serve_connection(
                        router.clone(),
                        acceptor.clone(),
                        graceful.watcher(),
                        stream,
                        peer,
                    ));
                }
                result = &mut termination => break result,
                Some(()) = connections.next() => {}
            }
        };

        // Refuse backlog connections before draining in-flight work.
        drop(listener);
        let drain = async { while connections.next().await.is_some() {} };
        tokio::join!(graceful.shutdown(), drain);
        outcome
    }
}
