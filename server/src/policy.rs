//! Every deploy-time constant, in one place. Each carries the one line saying why
//! this value and not another; no use site restates one.

/// Adopted whole. No inline-script hash despite two inline `<script>` tags: `ld+json` is a data
/// block the check never reaches, and `speculationrules` has a keyword narrower than a hash.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self' 'inline-speculation-rules'; \
     base-uri 'none'; \
     form-action 'self'; \
     frame-ancestors 'none'; \
     object-src 'none'";

/// Two years, which the preload list recommends. Unconditional: RFC 6797 §8.1 makes a user agent
/// ignore it over plain HTTP, so a branch here would be a fallback.
pub const STRICT_TRANSPORT_SECURITY: &str = "max-age=63072000; includeSubDomains; preload";

/// One year, the preload list's own minimum — a bound set by someone else.
pub const HSTS_PRELOAD_MIN_MAX_AGE: u64 = 31_536_000;

/// A document this origin opens, or that opens it, cannot reach across via `window.opener`.
pub const CROSS_ORIGIN_OPENER_POLICY: &str = "same-origin";

/// TCP accept to finished handshake — axum-server's default, kept when its loop was replaced.
pub const TLS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The pause before retrying accept after EMFILE — hyper's documented handling, inherited by axum.
pub const ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);
