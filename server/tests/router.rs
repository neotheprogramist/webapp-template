#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code is direct by contract"
)]

mod common;

use axum::http::{StatusCode, header};
use common::{
    built, get, header_of, http_config, one_line, respond, respond_tagged, templates_dir, token,
};
use proptest::prelude::*;
use server::{
    headers,
    router::{NOT_FOUND_CONTENT_TYPE, app},
};

fn directory_pages(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut pending = vec![root.to_owned()];
    let mut pages = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).expect("the built tree is readable") {
            let path = entry.expect("the built tree entry is readable").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|name| name == "index.html") {
                pages.push(path);
            }
        }
    }
    pages.sort_unstable();
    pages
}

proptest! {
    #![proptest_config(http_config())]

    #[test]
    fn every_response_carries_every_declared_header(path in "/[a-z0-9/-]{0,40}") {
        let (_, head, _) = respond(get(&path));
        for (name, value) in headers::declared() {
            let declared = String::from_utf8_lossy(value.as_bytes()).into_owned();
            prop_assert_eq!(
                header_of(&head, name.as_str()),
                Some(declared.as_str()),
                "{} on {}", name, path
            );
        }
    }

    #[test]
    fn refused_methods_answer_405_with_the_route_allow_set(id in "[0-9a-f]{32}") {
        for path in [format!("/{id}/"), "/version".to_owned()] {
            let oracle = axum::http::Request::builder()
                .method("OPTIONS")
                .uri(&path)
                .body(axum::body::Body::empty())
                .unwrap();
            let (status, head, _) = respond(oracle);
            prop_assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "OPTIONS {}", path);
            let mut served: Vec<_> = header_of(&head, header::ALLOW.as_str())
                .expect("a 405 exposes the built router method set")
                .split(',')
                .map(str::trim)
                .collect();
            served.sort_unstable();
            prop_assert!(!served.is_empty(), "{path} serves at least one method");

            for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
                let request = axum::http::Request::builder()
                    .method(method)
                    .uri(&path)
                    .body(axum::body::Body::empty())
                    .unwrap();
                let (status, head, _) = respond(request);
                if served.contains(&method) {
                    prop_assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{} {}", method, path);
                    continue;
                }
                prop_assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{} {}", method, path);
                let mut allowed: Vec<_> = header_of(&head, header::ALLOW.as_str())
                    .expect("a 405 names its method set")
                    .split(',')
                    .map(str::trim)
                    .collect();
                allowed.sort_unstable();
                prop_assert_eq!(allowed, served.as_slice(), "{} {}", method, path);
            }
        }
    }

    #[test]
    fn an_unknown_path_answers_404_with_the_built_error_page(id in "[0-9a-f]{32}") {
        let (status, head, body) = respond(get(&format!("/{id}/")));
        prop_assert_eq!(status, StatusCode::NOT_FOUND);
        prop_assert_eq!(body, built("404/index.html"));
        prop_assert_eq!(
            header_of(&head, header::CONTENT_TYPE.as_str()),
            Some(NOT_FOUND_CONTENT_TYPE)
        );
    }

    #[test]
    fn a_tree_without_a_404_page_refuses_to_build(name in "[a-z]{8}") {
        let empty = tempfile::TempDir::new().expect("a temp dir");
        let dir = empty.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let Err(error) = runtime.block_on(app(dir.clone())) else {
            panic!("an unbuilt tree cannot serve a 404");
        };
        prop_assert!(
            error.to_string().contains(&dir.join("404/index.html").display().to_string()),
            "the error names the missing file, got {}",
            error
        );
    }

    #[test]
    fn every_request_logs_one_access_line(
        id in "[0-9a-f]{32}",
        agent in "[A-Za-z0-9/. ]{1,30}",
    ) {
        let path = format!("/{id}/");
        let agent = format!("{agent} {}", token());
        let request = axum::http::Request::get(&path)
            .header(header::REFERER, "https://example.test/from")
            .body(axum::body::Body::empty())
            .unwrap();
        let (status, _, _) = respond_tagged(&agent, request);
        prop_assert_eq!(status, StatusCode::NOT_FOUND);

        let line = one_line(&agent, "request.serve");
        prop_assert!(line.contains("method=GET"), "{}", line);
        prop_assert!(line.contains(&format!("path={path} ")), "{}", line);
        prop_assert!(line.contains(&format!("user_agent=\"{agent}\"")), "{}", line);
        prop_assert!(line.contains("referer=\"https://example.test/from\""), "{}", line);
        prop_assert!(line.contains(&format!("status={}", status.as_u16())), "{}", line);
        prop_assert!(line.contains("latency_ms="), "{}", line);
        prop_assert!(!line.contains("visitor="), "{}", line);
        prop_assert!(!line.contains(" ip="), "{}", line);
    }
}

#[test]
fn every_built_page_is_served_from_the_tree() {
    let root = templates_dir();
    let pages = directory_pages(&root);
    assert!(!pages.is_empty(), "the built tree carries directory pages");
    for page in pages {
        let relative = page
            .strip_prefix(&root)
            .expect("a page belongs to the built tree");
        let parent = relative.parent().expect("an index page has a parent");
        let url = if parent.as_os_str().is_empty() {
            "/".to_owned()
        } else {
            format!("/{}/", parent.to_string_lossy())
        };
        let (status, _, body) = respond(get(&url));
        assert_eq!(status, StatusCode::OK, "{url}");
        assert_eq!(body, built(&relative.to_string_lossy()), "{url}");
    }
}
