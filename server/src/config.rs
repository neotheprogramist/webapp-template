use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

use clap::{Parser, builder::TypedValueParser};

fn non_empty_path() -> impl TypedValueParser<Value = PathBuf> {
    clap::builder::NonEmptyStringValueParser::new().map(PathBuf::from)
}

#[derive(Parser, Debug)]
#[command(name = "webapp-server")]
pub struct Config {
    /// Interface to bind.
    #[arg(long, env = "APP_HOST", default_value = "::")]
    host: IpAddr,

    /// TCP port. Use 0 for an ephemeral port.
    #[arg(long, env = "APP_PORT", default_value_t = 0)]
    port: u16,

    /// Static build output to serve.
    #[arg(
        long,
        env = "APP_TEMPLATES_DIR",
        default_value = "server/templates",
        value_parser = non_empty_path()
    )]
    templates_dir: PathBuf,

    #[cfg(all(feature = "self-signed", not(feature = "acme")))]
    #[command(flatten)]
    tls: TlsConfig,

    #[cfg(feature = "acme")]
    #[command(flatten)]
    acme: AcmeConfig,
}

impl Config {
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }

    pub fn templates_dir(&self) -> &Path {
        &self.templates_dir
    }

    #[cfg(all(feature = "self-signed", not(feature = "acme")))]
    pub fn tls_cert(&self) -> &Path {
        &self.tls.cert
    }

    #[cfg(all(feature = "self-signed", not(feature = "acme")))]
    pub fn tls_key(&self) -> &Path {
        &self.tls.key
    }

    #[cfg(feature = "acme")]
    pub fn acme(&self) -> &AcmeConfig {
        &self.acme
    }
}

#[cfg(all(feature = "self-signed", not(feature = "acme")))]
#[derive(clap::Args, Debug)]
pub struct TlsConfig {
    /// PEM certificate to serve.
    #[arg(long = "tls-cert", env = "APP_TLS_CERT", value_parser = non_empty_path())]
    cert: PathBuf,

    /// PEM private key for the certificate.
    #[arg(long = "tls-key", env = "APP_TLS_KEY", value_parser = non_empty_path())]
    key: PathBuf,
}

#[cfg(feature = "acme")]
#[derive(Debug, Clone)]
pub struct AcmeEmail(String);

#[cfg(feature = "acme")]
impl AcmeEmail {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(feature = "acme")]
#[derive(Debug, thiserror::Error)]
pub enum AcmeEmailError {
    #[error(transparent)]
    Pattern(#[from] crate::patterns::PatternError),

    #[error("expected an address of the form name@domain.tld")]
    Malformed,
}

#[cfg(feature = "acme")]
impl std::str::FromStr for AcmeEmail {
    type Err = AcmeEmailError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Ok(Self(
            crate::patterns::email(raw)?
                .ok_or(AcmeEmailError::Malformed)?
                .to_owned(),
        ))
    }
}

#[cfg(feature = "acme")]
#[derive(clap::Args, Debug)]
pub struct AcmeConfig {
    /// Domains to obtain the certificate for (comma-separated).
    #[arg(
        long = "acme-domains",
        env = "APP_ACME_DOMAINS",
        value_delimiter = ',',
        required = true,
        value_parser = clap::builder::NonEmptyStringValueParser::new()
    )]
    domains: Vec<String>,

    /// Contact email for the ACME account.
    #[arg(long = "acme-email", env = "APP_ACME_EMAIL")]
    email: AcmeEmail,

    /// Directory the obtained certificates are cached in across restarts.
    #[arg(long, env = "APP_CERTS_DIR", value_parser = non_empty_path())]
    certs_dir: PathBuf,

    /// Use the production Let's Encrypt directory (default: staging).
    #[arg(long = "acme-production", env = "APP_ACME_PRODUCTION")]
    production: bool,
}

#[cfg(feature = "acme")]
impl AcmeConfig {
    pub fn domains(&self) -> &[String] {
        &self.domains
    }

    pub fn email(&self) -> &AcmeEmail {
        &self.email
    }

    pub fn certs_dir(&self) -> &Path {
        &self.certs_dir
    }

    pub fn production(&self) -> bool {
        self.production
    }
}
