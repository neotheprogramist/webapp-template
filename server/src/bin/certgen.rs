use std::path::{Path, PathBuf};

use clap::Parser;
use rcgen::CertifiedKey;
use tokio::io::AsyncWriteExt;
use tracing::info;

#[derive(Debug, thiserror::Error)]
enum CertificateError {
    #[error(transparent)]
    Generation(#[from] rcgen::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Opens with owner-only permissions; `tokio::fs::write` would honor a permissive umask.
async fn save(pem: &str, path: &Path) -> Result<(), CertificateError> {
    let dir = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(dir).await?;

    let mut file = tokio::fs::OpenOptions::new()
        .mode(0o600)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .await?;
    file.write_all(pem.as_bytes()).await?;
    file.sync_all().await?;
    Ok(())
}

#[derive(Parser)]
#[command(name = "certgen", about = "Generate a self-signed certificate")]
struct Args {
    #[arg(short, long, env = "CERT_PATH", default_value = "./certs/cert.pem")]
    cert_path: PathBuf,
    #[arg(short, long, env = "KEY_PATH", default_value = "./certs/key.pem")]
    key_path: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), CertificateError> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let args = Args::parse();

    let CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(["localhost".into(), "::1".into()])?;
    save(&cert.pem(), &args.cert_path).await?;
    save(&signing_key.serialize_pem(), &args.key_path).await?;
    info!(
        event = "certgen.write",
        cert = %args.cert_path.display(),
        key = %args.key_path.display(),
    );
    Ok(())
}
