#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

#[cfg(feature = "acme")]
mod common;

mod base {
    use proptest::prelude::*;
    use server::config::Config;

    fn argv(extra: &[String]) -> Vec<String> {
        let mut argv = vec!["webapp-server".to_owned()];
        #[cfg(all(feature = "self-signed", not(feature = "acme")))]
        argv.extend([
            "--tls-cert=/tmp/app-cert.pem".to_owned(),
            "--tls-key=/tmp/app-key.pem".to_owned(),
        ]);
        #[cfg(feature = "acme")]
        argv.extend([
            "--acme-domains=example.com".to_owned(),
            "--acme-email=a@b.co".to_owned(),
            "--certs-dir=/tmp/app-certs".to_owned(),
        ]);
        argv.extend_from_slice(extra);
        argv
    }

    proptest! {
        #[test]
        fn host_and_port_reach_the_bind_address(
            octets in proptest::array::uniform4(any::<u8>()),
            port in any::<u16>(),
        ) {
            let host = std::net::IpAddr::from(octets);
            let cfg = clap::Parser::try_parse_from(argv(&[
                format!("--host={host}"),
                format!("--port={port}"),
            ]));
            let cfg: Config = cfg.expect("a valid address is accepted");
            prop_assert_eq!(cfg.addr(), std::net::SocketAddr::new(host, port));
        }

        #[test]
        fn templates_dir_is_verbatim_and_never_empty(dir in "/tmp/app-[a-z0-9/]{1,20}") {
            let cfg: Config = clap::Parser::try_parse_from(argv(&[
                format!("--templates-dir={dir}"),
            ])).expect("a non-empty path is accepted");
            prop_assert_eq!(cfg.templates_dir(), std::path::Path::new(&dir));

            let empty: Result<Config, _> =
                clap::Parser::try_parse_from(argv(&["--templates-dir=".to_owned()]));
            let error = empty.expect_err("an empty path is refused").to_string();
            prop_assert!(error.contains("templates-dir"), "{}", error);
        }
    }
}

#[cfg(all(feature = "self-signed", not(feature = "acme")))]
mod pem {
    use proptest::prelude::*;
    use server::config::Config;

    proptest! {
        #[test]
        fn the_pair_is_verbatim_required_and_non_empty(
            cert in "/tmp/app-[a-z0-9]{1,12}\\.pem",
            key in "/tmp/app-[a-z0-9]{1,12}\\.pem",
        ) {
            let complete = [
                "webapp-server".to_owned(),
                format!("--tls-cert={cert}"),
                format!("--tls-key={key}"),
            ];
            let cfg: Config = clap::Parser::try_parse_from(complete.clone())
                .expect("a full pair is accepted");
            prop_assert_eq!(cfg.tls_cert(), std::path::Path::new(&cert));
            prop_assert_eq!(cfg.tls_key(), std::path::Path::new(&key));

            for flag in ["--tls-cert", "--tls-key"] {
                let prefix = format!("{flag}=");
                let mut without: Vec<_> = complete.to_vec();
                without.retain(|arg| !arg.starts_with(&prefix));
                let dropped: Result<Config, _> = clap::Parser::try_parse_from(without);
                prop_assert!(dropped.is_err(), "{} is required", flag);

                let mut emptied = complete.to_vec();
                for arg in &mut emptied {
                    if arg.starts_with(&prefix) {
                        *arg = prefix.clone();
                    }
                }
                let emptied: Result<Config, _> = clap::Parser::try_parse_from(emptied);
                let error = emptied.expect_err("an empty path is refused").to_string();
                prop_assert!(error.contains(flag.trim_start_matches("--")), "{}", error);
            }
        }
    }
}

#[cfg(feature = "acme")]
mod acme {
    use clap::Parser;
    use proptest::prelude::*;
    use server::config::Config;

    use crate::common::{ADVERSARIAL_LOCALS, MALFORMATIONS, address_parts, malformed, padding};

    fn locals(drawn: &str) -> Vec<String> {
        std::iter::once(drawn.to_owned())
            .chain(ADVERSARIAL_LOCALS.iter().map(|l| (*l).to_owned()))
            .collect()
    }

    const REQUIRED: [&str; 3] = ["--acme-domains", "--acme-email", "--certs-dir"];

    fn args(domains: &str, email: &str, certs: &str) -> Vec<String> {
        vec![
            "webapp-server".to_owned(),
            format!("--acme-domains={domains}"),
            format!("--acme-email={email}"),
            format!("--certs-dir={certs}"),
        ]
    }

    proptest! {
        #[test]
        fn every_acme_flag_reaches_its_accessor(
            hosts in prop::collection::vec("[a-z][a-z0-9-]{0,18}\\.[a-z]{2,6}", 2..4),
            certs in "/tmp/app-[a-z0-9]{1,12}",
            parts in address_parts(),
        ) {
            let (local, domain, tld) = &parts;
            for local in locals(local) {
                let email = format!("{local}@{domain}.{tld}");
                for shape in [&hosts[..1], &hosts[..]] {
                    for production in [false, true] {
                        let mut argv = args(&shape.join(","), &email, &certs);
                        if production {
                            argv.push("--acme-production".to_owned());
                        }
                        let cfg = Config::try_parse_from(argv).expect("the flags are valid");
                        let acme = cfg.acme();
                        prop_assert_eq!(acme.domains(), shape);
                        prop_assert_eq!(acme.certs_dir(), std::path::Path::new(&certs));
                        prop_assert_eq!(acme.email().as_str(), &email);
                        prop_assert_eq!(acme.production(), production);
                    }
                }
            }
        }

        #[test]
        fn a_malformed_acme_address_is_refused_at_startup(
            parts in address_parts(),
            pad in padding(),
            certs in "/tmp/app-[a-z0-9]{1,12}",
        ) {
            let (_, domain, tld) = &parts;
            for local in locals(&parts.0) {
                let shaped = (local, domain.clone(), tld.clone());
                for kind in MALFORMATIONS {
                    let raw = format!("{pad}{}{pad}", malformed(kind, &shaped));
                    let error = Config::try_parse_from(args("example.com", &raw, &certs))
                        .expect_err("a malformed address is refused")
                        .to_string();
                    prop_assert!(error.contains("acme-email"), "{:?} gave {}", raw, error);
                }
            }
            let empty = Config::try_parse_from(args("example.com", "", &certs));
            prop_assert!(empty.is_err(), "an empty address is not an address");
        }

        #[test]
        fn a_padded_acme_address_parses_to_its_core(
            parts in address_parts(),
            before in padding(),
            after in padding(),
            certs in "/tmp/app-[a-z0-9]{1,12}",
        ) {
            let (local, domain, tld) = &parts;
            for local in locals(local) {
                let email = format!("{local}@{domain}.{tld}");
                let cfg = Config::try_parse_from(args(
                    "example.com",
                    &format!("{before}{email}{after}"),
                    &certs,
                ))
                .expect("a padded address is still an address");
                prop_assert_eq!(cfg.acme().email().as_str(), &email);
            }
        }

        #[test]
        fn every_required_acme_flag_is_required(
            parts in address_parts(),
            certs in "/tmp/app-[a-z0-9]{1,12}",
        ) {
            let (local, domain, tld) = &parts;
            let email = format!("{local}@{domain}.{tld}");
            let complete = args("example.com", &email, &certs);
            prop_assert!(Config::try_parse_from(complete.clone()).is_ok());
            for flag in REQUIRED {
                let prefix = format!("{flag}=");
                let mut without = complete.clone();
                without.retain(|arg| !arg.starts_with(&prefix));
                prop_assert_eq!(without.len(), complete.len() - 1, "{} was present", flag);
                prop_assert!(
                    Config::try_parse_from(without).is_err(),
                    "{} is required",
                    flag
                );
            }
        }
    }
}
