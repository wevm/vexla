//! Self-hosted feature flags for Rust. The crate reads the same flags file, override format, and
//! signatures as the TypeScript `flargs` package.
//!
//! - [`definitions`]: validation of `flags.toml` and `flags.json`, and the decoding of variable values.
//! - [`overrides`]: the `flag.*` search parameters, with HMAC-SHA256 signatures.
//! - [`flags!`]: typed flags from a flags file at compile time (the `macros` feature, on by default).
//!
//! The crate is pure: it reads no file, no environment, no clock, and no network at run time.
//! `Runtime`, `Store`, and the `axum`, `build`, `client`, and `server` features come in a later
//! release.

use std::marker::PhantomData;

pub use flargs_definitions as definitions;
pub use flargs_definitions::Json;
/// Reads a flags file at compile time and generates typed flags.
///
/// The path is relative to `CARGO_MANIFEST_DIR` and ends in `.toml` or `.json`. An optional
/// `env_prefix = "..."` replaces `FEATURE_`. An invalid declaration fails the build with an error
/// that names the key.
///
/// The macro generates:
///
/// - `Flags`: a struct with one typed field for each runtime flag, and `Default` from the defaults.
/// - One [`Key`] constant for each runtime flag, such as `Flags::NEW_CHECKOUT`.
/// - One constant for each build flag, such as `Flags::MAINTENANCE_BANNER`, from its variable at
///   compile time, then its default. A change of the variable rebuilds the crate. A JSON build flag
///   is a `&str` that holds the JSON text.
/// - One enum for each select flag, with a variant in `PascalCase` for each option, such as
///   `Pricing::A`.
///
/// ```ignore
/// flargs::flags!("flags.toml");
///
/// if Flags::MAINTENANCE_BANNER {
///     // ...
/// }
/// ```
#[cfg(feature = "macros")]
pub use flargs_macros::flags;

pub mod overrides;

/// The typed key of a runtime flag. `flargs::flags!` declares one for each runtime flag, such as
/// `Flags::NEW_CHECKOUT`.
pub struct Key<T> {
    env: &'static str,
    name: &'static str,
    value: PhantomData<fn() -> T>,
}

impl<T> Key<T> {
    /// Returns the key of the flag `key`, which reads the variable `env`.
    pub const fn new(key: &'static str, env: &'static str) -> Self {
        Self {
            env,
            name: key,
            value: PhantomData,
        }
    }

    /// Returns the environment variable of the flag.
    pub const fn env(&self) -> &'static str {
        self.env
    }

    /// Returns the key of the flag, as the manifest and the overrides write it.
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
