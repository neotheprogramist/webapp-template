#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

mod common;

use common::{HISTORICAL_ADDRESSES, MALFORMATIONS, address_parts, malformed, padding};
use proptest::prelude::*;
use server::patterns::email;

fn address(raw: &str) -> Option<&str> {
    email(raw).expect("the email pattern compiles")
}

proptest! {
    #[test]
    fn a_dotted_address_is_accepted_and_trimmed(
        parts in address_parts(),
        before in padding(),
        after in padding(),
    ) {
        let (local, domain, tld) = &parts;
        let expected = format!("{local}@{domain}.{tld}");
        let raw = format!("{before}{expected}{after}");
        prop_assert_eq!(address(&raw), Some(expected.as_str()));
    }

    #[test]
    fn a_string_without_an_at_is_not_an_address(raw in r"[^@]{0,40}") {
        prop_assert_eq!(address(&raw), None);
    }

    #[test]
    fn every_malformed_shape_is_refused(
        parts in address_parts(),
        before in padding(),
        after in padding(),
    ) {
        for kind in MALFORMATIONS {
            let raw = format!("{before}{}{after}", malformed(kind, &parts));
            prop_assert_eq!(address(&raw), None, "{:?}: {}", kind, raw);
        }
    }
}

#[test]
fn historical_malformed_addresses_remain_refused() {
    let floor = ("a".to_owned(), "b".to_owned(), "co".to_owned());
    for (kind, historical) in HISTORICAL_ADDRESSES {
        assert_eq!(malformed(kind, &floor), historical, "{kind:?}");
        assert_eq!(address(historical), None, "{historical} is refused");
    }
}
