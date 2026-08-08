//! Unix shutdown signals parsed once into a closed event set.

use std::future::Future;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownSignal {
    Interrupt,
    Terminate,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to register a shutdown signal handler")]
    Register(#[from] std::io::Error),
}

pub fn listen() -> Result<impl Future<Output = ShutdownSignal>, Error> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => ShutdownSignal::Interrupt,
            _ = terminate.recv() => ShutdownSignal::Terminate,
        }
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::{ShutdownSignal, listen};

    #[tokio::test]
    async fn every_declared_signal_is_observed() -> Result<(), Box<dyn std::error::Error>> {
        for (name, expected) in [
            ("INT", ShutdownSignal::Interrupt),
            ("TERM", ShutdownSignal::Terminate),
        ] {
            let observed = listen()?;
            let status = Command::new("kill")
                .args([format!("-{name}"), std::process::id().to_string()])
                .status();
            assert!(status?.success(), "the signal reaches this test process");
            assert_eq!(observed.await, expected);
        }
        Ok(())
    }
}
