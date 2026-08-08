use clap::Parser;
use server::{config::Config, error::Error, router::app, serve};

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::builder()
                .with_default_directive(tracing::level_filters::LevelFilter::INFO.into())
                .from_env()?,
        )
        .init();

    let cfg = Config::parse();
    serve(app(cfg.templates_dir().to_owned()).await?, &cfg).await
}
