//! Self-hosted feature flags for Rust. The crate reads the same flags file, override format, and
//! signatures as the TypeScript `vexla` package, and serves the same HTTP API.
//!
//! - [`definitions`]: the `.env.flags` file, validation of definitions, and the decoding of variable
//!   values.
//! - [`overrides`]: the `flag.*` search parameters, with HMAC-SHA256 signatures.
//! - [`flags!`]: typed flags from `.env.flags` at compile time (the `macros` feature, on by default).
//! - [`Runtime`]: resolves flag values for each request, in the order override, store value,
//!   `decide`, environment, then default.
//! - [`Store`] and [`MemoryStore`]: where the admin API keeps values, and optionally definitions.
//! - `server` feature: `Runtime::service` and `Runtime::layer`, the dev route and the admin API as
//!   a `tower::Service` and a `tower::Layer`.
//! - `axum` feature: the `vexla::axum::Flags` extractor.
//! - `client` feature: `client::HttpStore` and `client::Client`, over the HTTP API of another
//!   runtime. The feature enables no TLS backend. Enable one on `reqwest`, such as `rustls`.
//! - `build` feature: `build::pull`, which sets build flag variables in `build.rs`.

use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

pub use runtime::{Access, Builder, Runtime, Source};
pub use store::{BoxError, MemoryStore, Store};
pub use vexla_definitions as definitions;
pub use vexla_definitions::Json;
/// Reads `.env.flags` at compile time and generates typed flags.
///
/// The path is relative to `CARGO_MANIFEST_DIR`, and the file has the format of `.env.flags`: each
/// variable declares a flag with its default, its name is the key of the flag, and the comment lines
/// above it hold the description and tags such as `@type {boolean}`. An invalid declaration fails
/// the build with an error that names the key and the line.
///
/// The macro generates:
///
/// - `Flags`: a struct with one typed field for each runtime flag, named in lowercase `snake_case`
///   (`NEW_CHECKOUT` is `new_checkout`), `Default` from the defaults, and [`FlagSet`], so
///   `Runtime::<Flags>` reads the definitions of the file.
/// - One [`Key`] constant for each runtime flag, such as `Flags::NEW_CHECKOUT`.
/// - One constant for each build flag, such as `Flags::MAINTENANCE_BANNER`, from its variable at
///   compile time, then its default. A change of the variable rebuilds the crate. A JSON build flag
///   is a `&str` that holds the JSON text.
/// - One enum for each select flag, named in `PascalCase` from the key (`PRICING` is `Pricing`),
///   with a variant in `PascalCase` for each option, such as `Pricing::A`, and [`FlagValue`].
///
/// ```ignore
/// vexla::flags!(".env.flags");
///
/// if Flags::MAINTENANCE_BANNER {
///     // ...
/// }
/// ```
#[cfg(feature = "macros")]
pub use vexla_macros::flags;

#[cfg(feature = "axum")]
pub mod axum;
#[cfg(feature = "build")]
pub mod build;
#[cfg(feature = "client")]
pub mod client;
pub mod overrides;
mod runtime;
#[cfg(feature = "server")]
mod server;
mod store;

#[cfg(feature = "server")]
pub use server::{Layer, Middleware, Service};

/// An error of the runtime. [`Runtime`] reports the errors that do not fail a request through
/// `on_error`.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The context of `identify` is not the type that a `decide` function of the flag reads.
    Context {
        /// The key of the flag.
        key: String,
    },
    /// The store did not return the flag definitions. With no definitions, no default exists.
    DefinitionsUnavailable(BoxError),
    /// An override signature does not match, or has expired.
    InvalidSignature(overrides::InvalidSignatureError),
    /// A store value, a `decide` result, or a variable is not a value of its flag.
    InvalidValue(definitions::InvalidValueError),
    /// The runtime has no secret outside dev mode.
    MissingSecret,
    /// An override was dropped.
    Override(overrides::Error),
    /// A store operation failed.
    Store(BoxError),
    /// No flag declares the key.
    UnknownFlag {
        /// The key.
        key: String,
    },
}

impl Error {
    /// Returns the name of the error, as the TypeScript package writes it.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Context { .. } => "Runtime.ContextError",
            Self::DefinitionsUnavailable(_) => "Runtime.DefinitionsUnavailableError",
            Self::InvalidSignature(_) => "Override.InvalidSignatureError",
            Self::InvalidValue(_) => "Definitions.InvalidValueError",
            Self::MissingSecret => "TypeError",
            Self::Override(error) => error.name(),
            Self::Store(_) => "Runtime.StoreError",
            Self::UnknownFlag { .. } => "Runtime.UnknownFlagError",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Context { key } => write!(
                f,
                "The context of `identify` is not the type that `decide` of {key} reads.\n\nTo resolve: Make `identify` return the type that the `decide` function receives."
            ),
            Self::DefinitionsUnavailable(_) => f.write_str(
                "The store did not return the flag definitions.\n\nTo resolve: Check the connection to the store, or declare the flags in a flags file.",
            ),
            Self::InvalidSignature(error) => error.fmt(f),
            Self::InvalidValue(error) => error.fmt(f),
            Self::MissingSecret => f.write_str(
                "`Runtime::builder` needs `secret` outside dev mode. Set `secret`, such as from `VEXLA_SECRET`.",
            ),
            Self::Override(error) => error.fmt(f),
            Self::Store(error) => write!(
                f,
                "The store operation failed: {error}\n\nTo resolve: Check the connection to the store."
            ),
            Self::UnknownFlag { key } => write!(
                f,
                "No flag declares the key {key}.\n\nTo resolve: Check the key against the flags file."
            ),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::DefinitionsUnavailable(error) | Self::Store(error) => Some(error.as_ref()),
            Self::InvalidSignature(error) => Some(error),
            Self::InvalidValue(error) => Some(error),
            Self::Override(error) => Some(error),
            _ => None,
        }
    }
}

/// The flags of a project, as a [`Runtime`] reads them. `vexla::flags!` implements it for the
/// generated `Flags` struct. [`Values`] implements it for definitions that the store or the
/// environment holds.
pub trait FlagSet: Sized {
    /// Returns the definitions of the flags file, or `None` when the store or the environment holds
    /// them.
    fn definitions() -> Option<definitions::Definitions>;

    /// Returns the flags from `values`, keyed by flag key. A missing or invalid value takes the
    /// default.
    fn from_values(values: &Values) -> Self;
}

impl FlagSet for Values {
    fn definitions() -> Option<definitions::Definitions> {
        None
    }

    fn from_values(values: &Values) -> Self {
        values.clone()
    }
}

/// A Rust type that holds the value of a flag.
pub trait FlagValue: Sized {
    /// Returns the value in `json`, or `None` when `json` holds another type.
    fn from_json(json: &Json) -> Option<Self>;

    /// Returns the value as JSON.
    fn to_json(&self) -> Json;
}

impl FlagValue for bool {
    fn from_json(json: &Json) -> Option<Self> {
        json.as_bool()
    }

    fn to_json(&self) -> Json {
        Json::Bool(*self)
    }
}

impl FlagValue for f64 {
    fn from_json(json: &Json) -> Option<Self> {
        json.as_f64()
    }

    fn to_json(&self) -> Json {
        Json::from(*self)
    }
}

impl FlagValue for Json {
    fn from_json(json: &Json) -> Option<Self> {
        Some(json.clone())
    }

    fn to_json(&self) -> Json {
        self.clone()
    }
}

impl FlagValue for String {
    fn from_json(json: &Json) -> Option<Self> {
        json.as_str().map(str::to_owned)
    }

    fn to_json(&self) -> Json {
        Json::String(self.clone())
    }
}

/// Flag values keyed by flag key.
pub type Values = BTreeMap<String, Json>;

/// The typed key of a runtime flag. `vexla::flags!` declares one for each runtime flag, such as
/// `Flags::NEW_CHECKOUT`.
pub struct Key<T> {
    name: &'static str,
    value: PhantomData<fn() -> T>,
}

impl<T> Key<T> {
    /// Returns the key of the flag `key`, which is also its environment variable.
    pub const fn new(key: &'static str) -> Self {
        Self {
            name: key,
            value: PhantomData,
        }
    }

    /// Returns the key of the flag, as the environment, the manifest, and the overrides write it.
    pub const fn key(&self) -> &'static str {
        self.name
    }
}

impl<T> Clone for Key<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Key<T> {}
