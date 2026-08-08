#![cfg(not(feature = "acme"))]
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

mod common;

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::net::UnixDatagram,
    process::{Child, Command, ExitStatus, Stdio},
    time::Duration,
};

const READY: &[u8] = b"READY=1\n";

/// Policy: the wait for a signal that follows a BOOT, not a build — the binary is already compiled
/// by the time a test runs. Measured at well under a second locally; this is slack for a loaded
/// runner, not an estimate of the boot itself.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Policy: a duplicate readiness send is queued with the first during the same startup edge. This
/// is scheduler slack for receiving an already-produced datagram, not a second boot allowance.
const DUPLICATE_TIMEOUT: Duration = Duration::from_millis(100);

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _unused = self.0.kill();
        let _unused = self.0.wait();
    }
}

fn assert_one_ready(manager: &UnixDatagram) {
    let mut received = [0u8; 64];
    let len = manager
        .recv(&mut received)
        .expect("READY arrives within the boot budget");
    assert_eq!(&received[..len], READY);

    manager
        .set_read_timeout(Some(DUPLICATE_TIMEOUT))
        .expect("a duplicate-read deadline");
    let duplicate = manager.recv(&mut received);
    let absent = matches!(
        &duplicate,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
    );
    assert!(
        absent,
        "readiness is emitted exactly once, got {duplicate:?}"
    );
}

fn listen_address(line: &str) -> SocketAddr {
    line.split_whitespace()
        .find_map(|field| field.strip_prefix("addr="))
        .expect("the listen event carries its address")
        .parse()
        .expect("the listen address parses")
}

fn assert_running(status: Option<ExitStatus>) {
    assert!(status.is_none(), "the server remains alive after readiness");
}

fn assert_ok_response(response: &str) {
    assert!(
        response.starts_with("HTTP/1.1 200 OK\r\n"),
        "the ready listener serves a 200 response: {response}"
    );
}

#[cfg(not(feature = "self-signed"))]
fn assert_serving(address: SocketAddr) {
    let mut stream = TcpStream::connect_timeout(&address, READY_TIMEOUT)
        .expect("the announced listener accepts a connection");
    stream
        .set_read_timeout(Some(READY_TIMEOUT))
        .expect("a response deadline");
    stream
        .write_all(b"GET /version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .expect("the request is written");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("the response is read");
    assert_ok_response(&response);
}

#[cfg(feature = "self-signed")]
fn assert_serving(address: SocketAddr, certificate: &std::path::Path) {
    use std::sync::Arc;

    use tokio_rustls::rustls::{
        ClientConfig, ClientConnection, RootCertStore, StreamOwned,
        pki_types::{CertificateDer, ServerName, pem::PemObject},
    };

    let pem = std::fs::read(certificate).expect("the generated certificate is readable");
    let mut roots = RootCertStore::empty();
    for certificate in CertificateDer::pem_slice_iter(&pem) {
        roots
            .add(certificate.expect("the generated certificate parses"))
            .expect("the generated certificate is a trust anchor");
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connection = ClientConnection::new(
        Arc::new(config),
        ServerName::try_from("localhost")
            .expect("localhost is a DNS name")
            .to_owned(),
    )
    .expect("a TLS client");
    let stream = TcpStream::connect_timeout(&address, READY_TIMEOUT)
        .expect("the announced listener accepts a connection");
    stream
        .set_read_timeout(Some(READY_TIMEOUT))
        .expect("a response deadline");
    let mut stream = StreamOwned::new(connection, stream);
    stream
        .write_all(b"GET /version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .expect("the request is written");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("the response is read");
    assert_ok_response(&response);
}

#[test]
fn the_server_signals_readiness_once_and_remains_serving() {
    let dir = tempfile::TempDir::new().expect("a temp dir");
    let socket_path = dir.path().join("notify.sock");

    // Bound BEFORE the child starts, which is also the order systemd uses: the manager owns the
    // socket and passes its path down, so a datagram is never sent into nothing.
    let manager = UnixDatagram::bind(&socket_path).expect("the notify socket binds");
    manager
        .set_read_timeout(Some(READY_TIMEOUT))
        .expect("a read deadline");

    let mut command = Command::new(env!("CARGO_BIN_EXE_server"));
    command
        .env("NOTIFY_SOCKET", &socket_path)
        .env("APP_PORT", "0")
        .env("APP_TEMPLATES_DIR", common::templates_dir())
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    // The PEM pair the self-signed build requires at parse; nothing is generated at serve time.
    #[cfg(feature = "self-signed")]
    let certs = {
        let certs = dir.path().join("certs");
        let status = Command::new(env!("CARGO_BIN_EXE_certgen"))
            .env("CERT_PATH", certs.join("cert.pem"))
            .env("KEY_PATH", certs.join("key.pem"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("certgen runs");
        assert!(status.success(), "certgen wrote a pair");
        certs
    };
    #[cfg(feature = "self-signed")]
    command
        .env("APP_TLS_CERT", certs.join("cert.pem"))
        .env("APP_TLS_KEY", certs.join("key.pem"));

    let mut server = Server(command.spawn().expect("the server binary starts"));
    let stdout = server.0.stdout.take().expect("stdout is piped");
    let mut stdout = BufReader::new(stdout);
    let mut logged = String::new();
    stdout
        .read_line(&mut logged)
        .expect("the listen event is readable");
    let address = listen_address(&logged);

    assert_one_ready(&manager);

    // The signal is not the server's last act: it is still up and still holding the listener it
    // announced. A READY from a process that then exits would satisfy the assertion above and be
    // exactly the failure `Notify=true` exists to catch.
    assert_running(server.0.try_wait().expect("the child is waitable"));

    #[cfg(not(feature = "self-signed"))]
    assert_serving(address);
    #[cfg(feature = "self-signed")]
    assert_serving(address, &certs.join("cert.pem"));

    drop(server);
    let _unused = stdout.read_to_string(&mut logged);
    assert!(logged.contains("event=\"server.listen\""));
}

#[test]
fn the_exact_once_witness_rejects_each_readiness_defect_class() {
    for messages in [&[b"STATUS=starting\n".as_slice()][..], &[READY, READY][..]] {
        let dir = tempfile::TempDir::new().expect("a temp dir");
        let socket_path = dir.path().join("notify.sock");
        let manager = UnixDatagram::bind(&socket_path).expect("the manager binds");
        let sender = UnixDatagram::unbound().expect("a sender socket");
        manager
            .set_read_timeout(Some(READY_TIMEOUT))
            .expect("a read deadline");
        sender.connect(&socket_path).expect("the sender connects");
        for message in messages {
            sender.send(message).expect("the control sends");
        }

        let rejected = std::panic::catch_unwind(|| assert_one_ready(&manager));
        assert!(rejected.is_err(), "the control must make the witness fail");
    }

    assert!(std::panic::catch_unwind(|| listen_address("event=\"server.listen\"")).is_err());
    assert!(
        std::panic::catch_unwind(|| assert_ok_response("HTTP/1.1 503 Service Unavailable\r\n"))
            .is_err()
    );
    let exited = Command::new("true").status().expect("the control exits");
    assert!(std::panic::catch_unwind(|| assert_running(Some(exited))).is_err());
}
