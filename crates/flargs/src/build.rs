//! The `build` feature: [`pull`] reads build flag values from the admin API of a runtime in
//! `build.rs`, so `flargs::flags!` compiles them into constants.
//!
//! A build flag takes its store value when the store holds a valid one, then its variable, then its
//! default. This order matches the `flargs/vite` plugin.

use std::collections::BTreeMap;

use crate::Json;
use crate::client::Error;
use crate::definitions;

/// The options of [`instructions`].
#[derive(Clone, Copy, Debug)]
pub struct Options<'a> {
    /// The environment of the build, for the variables of build flags.
    pub env: &'a BTreeMap<String, String>,
    /// A bearer token that the remote `authorize` accepts with `read` access.
    pub token: Option<&'a str>,
}

/// Reads the manifest at `url` with the token in `FLARGS_TOKEN`, and prints the Cargo
/// instructions of [`instructions`]. Call it from `build.rs`.
///
/// ```ignore
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     flargs::build::pull("https://api.example.com/.flags")?;
///     Ok(())
/// }
/// ```
///
/// # Errors
///
/// Returns [`Error`] when the request fails or the admin API returns an error status.
pub fn pull(url: &str) -> Result<(), Error> {
    let env: BTreeMap<String, String> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let token = env.get("FLARGS_TOKEN").cloned();
    let lines = instructions(
        url,
        &Options {
            env: &env,
            token: token.as_deref(),
        },
    )?;

    #[expect(
        clippy::print_stdout,
        reason = "Cargo reads build script instructions from stdout."
    )]
    for line in lines {
        println!("{line}");
    }
    Ok(())
}

/// Returns the Cargo instructions for the build flags in the manifest at `url`:
/// `cargo:rustc-env=<variable>=<value>` for each build flag, then `cargo:rerun-if-env-changed`
/// for `FLARGS_TOKEN` and each variable. The instructions never hold the token.
///
/// The request blocks the thread. In an async context, call it from a blocking task.
///
/// # Errors
///
/// Returns [`Error`] when the request fails or the admin API returns an error status.
pub fn instructions(url: &str, options: &Options<'_>) -> Result<Vec<String>, Error> {
    let path = "/manifest";
    let mut request =
        reqwest::blocking::Client::new().get(format!("{}{path}", url.trim_end_matches('/')));
    if let Some(token) = options.token {
        request = request.bearer_auth(token);
    }

    let response = request.send().map_err(Error::Request)?;
    if !response.status().is_success() {
        return Err(Error::Status {
            method: "GET".to_owned(),
            path: path.to_owned(),
            status: response.status().as_u16(),
        });
    }
    let manifest: Json = response.json().map_err(Error::Request)?;

    let mut values = Vec::new();
    let mut variables = vec!["FLARGS_TOKEN".to_owned()];

    for (key, flag) in manifest["flags"].as_object().into_iter().flatten() {
        if flag["build"] != Json::Bool(true) {
            continue;
        }
        // A manifest flag holds its definition, keyed by its variable.
        let declaration: serde_json::Map<String, Json> = flag
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(field, _)| {
                matches!(
                    field.as_str(),
                    "build" | "default" | "options" | "public" | "type"
                )
            })
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        let mut input = serde_json::Map::new();
        input.insert(key.clone(), Json::Object(declaration));
        let Some(definition) = definitions::parse(&Json::Object(input))
            .ok()
            .and_then(|mut parsed| parsed.remove(key))
        else {
            continue;
        };

        let stored = &flag["store"];
        let value = if !stored.is_null() && definitions::validate(&definition, stored) {
            definitions::encode(stored)
        } else if let Some(raw) = options.env.get(key) {
            raw.clone()
        } else {
            definitions::encode(&definition.default)
        };

        // Cargo reads one instruction for each line, so a value cannot hold a line break.
        if !value.contains(['\n', '\r']) {
            values.push(format!("cargo:rustc-env={key}={value}"));
        }
        variables.push(key.clone());
    }

    Ok(values
        .into_iter()
        .chain(
            variables
                .into_iter()
                .map(|variable| format!("cargo:rerun-if-env-changed={variable}")),
        )
        .collect())
}
