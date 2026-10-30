//! Overrides: the `flag.*` search parameters and the `flargs` cookie value that override flag
//! values for one browser, with HMAC-SHA256 signatures for private flags and share links.
//!
//! `override` is a reserved word in Rust, so this module is `overrides`. It matches the `Override`
//! module of the TypeScript package.

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use base64::Engine as _;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::{Digest as _, Sha256};

use crate::Json;
use crate::definitions::{self, Definitions, InvalidValueError};

/// The name of the cookie that holds the overrides of a browser.
pub const COOKIE: &str = "flargs";

/// The prefix of override search parameters.
pub const PREFIX: &str = "flag.";

/// An override that [`parse`] dropped. A dropped override never selects a value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// The value is not a value of the flag.
    InvalidValue(InvalidValueError),
    /// The flag does not accept the override.
    NotOverridable {
        /// The key of the flag.
        key: String,
        /// Why the flag does not accept the override.
        reason: Restriction,
    },
    /// No flag declares the key.
    UnknownFlag {
        /// The key in the override.
        key: String,
    },
}

impl Error {
    /// Returns the name of the error, as the TypeScript package and the shared vectors write it.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::InvalidValue(_) => "Definitions.InvalidValueError",
            Self::NotOverridable { .. } => "Override.NotOverridableError",
            Self::UnknownFlag { .. } => "Override.UnknownFlagError",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue(error) => error.fmt(f),
            Self::NotOverridable {
                key,
                reason: Restriction::Build,
            } => write!(
                f,
                "The build flag {key} accepts no override outside dev mode.\n\nTo resolve: Set the variable of the flag for the build, or override it in dev mode."
            ),
            Self::NotOverridable {
                key,
                reason: Restriction::Private,
            } => write!(
                f,
                "The private flag {key} accepts only a signed override outside dev mode.\n\nTo resolve: Request a signed link with `flargs link`, or `POST /.flags/links`."
            ),
            Self::UnknownFlag { key } => write!(
                f,
                "No flag declares the key {key}.\n\nTo resolve: Check the key against the flags file."
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Returned when an override signature does not match, or has expired.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidSignatureError {
    /// The signature has expired.
    Expired,
    /// The signature does not match the overrides.
    Mismatch,
    /// The input holds `flag.sig` but no valid `flag.exp`.
    MissingExpiry,
    /// The input holds `flag.sig`, but no secret verifies it.
    MissingSecret,
}

impl InvalidSignatureError {
    /// Returns the reason, as the TypeScript package and the shared vectors write it.
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Mismatch => "mismatch",
            Self::MissingExpiry => "missing expiry",
            Self::MissingSecret => "missing secret",
        }
    }
}

impl fmt::Display for InvalidSignatureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let details = match self {
            Self::Expired => "The override signature has expired.",
            Self::Mismatch => "The override signature does not match the overrides.",
            Self::MissingExpiry => "The signed override has no valid `flag.exp`.",
            Self::MissingSecret => {
                "The override is signed, but the runtime has no secret to verify it."
            }
        };
        let step = match self {
            Self::MissingSecret => "Set `secret` on the runtime, such as from `FLARGS_SECRET`.",
            _ => "Request a new link with `flargs link`, or `POST /.flags/links`.",
        };
        write!(f, "{details}\n\nTo resolve: {step}")
    }
}

impl std::error::Error for InvalidSignatureError {}

/// The overrides of a request, after verification and validation.
#[derive(Clone, Debug, PartialEq)]
pub struct Overrides {
    /// Overrides that were dropped, with the reason, in input order.
    pub errors: Vec<Error>,
    /// The expiry of a signed override, in milliseconds since the epoch.
    pub expires_at: Option<i64>,
    /// `true` when the input holds `flag.reset`, which clears every override.
    pub reset: bool,
    /// `true` when a valid signature covers the overrides.
    pub signed: bool,
    /// The override values, keyed by flag key.
    pub values: BTreeMap<String, Json>,
}

/// The options of [`parse`].
#[derive(Clone, Copy, Debug)]
pub struct ParseOptions<'a> {
    /// The definitions of the project.
    pub definitions: &'a Definitions,
    /// Dev mode: every flag accepts an unsigned override.
    pub dev: bool,
    /// The current time, in milliseconds since the epoch.
    pub now: i64,
    /// The HMAC secret, such as `FLARGS_SECRET`. A signed input needs it.
    pub secret: Option<&'a str>,
}

/// Why a flag does not accept an unsigned or a production override.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Restriction {
    /// A build flag accepts no override outside dev mode.
    Build,
    /// A private flag accepts only a signed override outside dev mode.
    Private,
}

/// The signature of [`serialize`].
#[derive(Clone, Copy, Debug)]
pub struct Signature<'a> {
    /// The expiry of the signature, in milliseconds since the epoch.
    pub expires_at: i64,
    /// The HMAC secret, such as `FLARGS_SECRET`.
    pub secret: &'a str,
}

/// Returns the overrides in `query`: the query string of a URL, with or without `?`, or a cookie
/// value.
///
/// - In dev mode, every flag accepts an unsigned override.
/// - In production, an unsigned override applies to a public runtime flag only. A signed override
///   applies to any runtime flag. A build flag accepts no override.
///
/// Unknown keys, invalid values, and flags that do not accept the override are dropped, and each
/// is reported in `errors`.
///
/// # Errors
///
/// Returns [`InvalidSignatureError`] when `flag.sig` does not match, or the signature has expired.
pub fn parse(query: &str, options: &ParseOptions<'_>) -> Result<Overrides, InvalidSignatureError> {
    let params = form_decode(query.strip_prefix('?').unwrap_or(query));
    let first = |name: &str| {
        params
            .iter()
            .find(|param| param.0 == name)
            .map(|param| param.1.as_str())
    };

    // As a `Map` in TypeScript: a repeated key takes the last value at the first position.
    let mut raw: Vec<(String, String)> = Vec::new();
    for (name, value) in &params {
        let Some(key) = name.strip_prefix(PREFIX) else {
            continue;
        };
        if matches!(key, "exp" | "reset" | "sig") {
            continue;
        }
        match raw.iter_mut().find(|entry| entry.0 == key) {
            Some(entry) => entry.1.clone_from(value),
            None => raw.push((key.to_owned(), value.clone())),
        }
    }

    let reset = first("flag.reset").is_some();

    let expires_at = match first("flag.sig") {
        None => None,
        Some(signature) => {
            let Some(secret) = options.secret.filter(|secret| !secret.is_empty()) else {
                return Err(InvalidSignatureError::MissingSecret);
            };
            let Some((exp, seconds)) = first("flag.exp")
                .and_then(|exp| exp.parse::<i64>().ok().map(|seconds| (exp, seconds)))
            else {
                return Err(InvalidSignatureError::MissingExpiry);
            };

            if !verify(&canonical(&raw, exp), signature, secret) {
                return Err(InvalidSignatureError::Mismatch);
            }

            let expires_at = seconds.saturating_mul(1000);
            if expires_at <= options.now {
                return Err(InvalidSignatureError::Expired);
            }
            Some(expires_at)
        }
    };

    let signed = expires_at.is_some();
    let mut errors = Vec::new();
    let mut values = BTreeMap::new();

    for (key, text) in raw {
        let Some(definition) = options.definitions.get(&key) else {
            errors.push(Error::UnknownFlag { key });
            continue;
        };

        if definition.build && !options.dev {
            errors.push(Error::NotOverridable {
                key,
                reason: Restriction::Build,
            });
            continue;
        }

        if !definition.public && !signed && !options.dev {
            errors.push(Error::NotOverridable {
                key,
                reason: Restriction::Private,
            });
            continue;
        }

        match definitions::decode(definition, &text, &key) {
            Ok(value) => {
                values.insert(key, value);
            }
            Err(error) => errors.push(Error::InvalidValue(error)),
        }
    }

    Ok(Overrides {
        errors,
        expires_at,
        reset,
        signed,
        values,
    })
}

/// Returns the query string of `values`, without `?`. With `signature`, it adds `flag.exp` and
/// `flag.sig`, so the overrides apply to private flags until `expires_at`.
pub fn serialize(values: &BTreeMap<String, Json>, signature: Option<&Signature<'_>>) -> String {
    let raw: Vec<(String, String)> = values
        .iter()
        .map(|(key, value)| (key.clone(), definitions::encode(value)))
        .collect();

    let mut params: Vec<(String, String)> = raw
        .iter()
        .map(|(key, value)| (format!("{PREFIX}{key}"), value.clone()))
        .collect();

    if let Some(signature) = signature {
        let exp = signature.expires_at.div_euclid(1000).to_string();
        let sig = sign(&canonical(&raw, &exp), signature.secret);
        params.push(("flag.exp".to_owned(), exp));
        params.push(("flag.sig".to_owned(), sig));
    }

    params
        .iter()
        .map(|(name, value)| format!("{}={}", form_encode(name), form_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The signed text: each `key=value` pair in key order, then `exp=<seconds>`, joined with `&`.
fn canonical(raw: &[(String, String)], exp: &str) -> String {
    let mut pairs: Vec<&(String, String)> = raw.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));

    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .chain([format!("exp={exp}")])
        .collect::<Vec<_>>()
        .join("&")
}

/// Decodes `application/x-www-form-urlencoded` text, as `URLSearchParams` does.
pub(crate) fn form_decode(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(name, true), percent_decode(value, true))
        })
        .collect()
}

/// Encodes text as `URLSearchParams` does: alphanumerics and `*-._` stay, a space is `+`.
pub(crate) fn form_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());

    for byte in text.bytes() {
        match byte {
            b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => {
                encoded.push(char::from(byte));
            }
            b' ' => encoded.push('+'),
            _ => {
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }

    encoded
}

/// Returns the HMAC-SHA256 instance of `secret`.
fn mac(secret: &str) -> Hmac<Sha256> {
    // HMAC zero-pads a key up to the block size and hashes a longer key first (RFC 2104), so this
    // equals `new_from_slice` without its impossible length error.
    let mut block = [0u8; 64];
    let digest;
    let key = if secret.len() > block.len() {
        digest = Sha256::digest(secret.as_bytes());
        digest.as_slice()
    } else {
        secret.as_bytes()
    };
    block
        .iter_mut()
        .zip(key)
        .for_each(|(byte, key)| *byte = *key);

    Hmac::new(&block.into())
}

/// Decodes `%XX` escapes, as `decodeURIComponent` does when `plus` is `false`. With `plus`, a `+`
/// is a space, as in form encoding.
pub(crate) fn percent_decode(text: &str, plus: bool) -> String {
    let hex = |byte: Option<&u8>| byte.and_then(|byte| char::from(*byte).to_digit(16));
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while let Some(&byte) = bytes.get(index) {
        index += 1;

        if plus && byte == b'+' {
            decoded.push(b' ');
            continue;
        }

        if byte == b'%'
            && let Some(high) = hex(bytes.get(index))
            && let Some(low) = hex(bytes.get(index + 1))
            && let Ok(value) = u8::try_from(high * 16 + low)
        {
            decoded.push(value);
            index += 2;
            continue;
        }

        decoded.push(byte);
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn sign(text: &str, secret: &str) -> String {
    let mut mac = mac(secret);
    mac.update(text.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Returns `true` when `signature`, in base64url with or without padding, signs `text`. The
/// comparison runs in constant time.
fn verify(text: &str, signature: &str, secret: &str) -> bool {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );

    let signature = signature.replace('+', "-").replace('/', "_");
    let Ok(bytes) = LENIENT.decode(signature) else {
        return false;
    };

    let mut mac = mac(secret);
    mac.update(text.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}
