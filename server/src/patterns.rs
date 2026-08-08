use std::sync::LazyLock;

use regex::Regex;

#[derive(Clone, Debug, thiserror::Error)]
#[error("invalid pattern")]
pub struct PatternError(#[from] regex::Error);

/// Deliberately checks only for local and domain parts; stricter syntax cannot prove deliverability.
static EMAIL: LazyLock<Result<Regex, PatternError>> =
    LazyLock::new(|| Ok(Regex::new(r"^\s*(?<addr>[^@\s]+@[^@\s]+\.[^@\s]+)\s*$")?));

pub fn email(raw: &str) -> Result<Option<&str>, PatternError> {
    let pattern = match &*EMAIL {
        Ok(pattern) => pattern,
        Err(error) => return Err(error.clone()),
    };
    Ok(pattern
        .captures(raw)
        .and_then(|captures| captures.name("addr"))
        .map(|addr| addr.as_str()))
}
