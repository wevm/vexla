//! The `client` feature: [`HttpStore`], a store over the admin API of another runtime, and
//! [`Client`], which reads the values endpoint. They match `Store.http` and `Values.load` in the
//! TypeScript package, and work against a TypeScript or a Rust runtime.
//!
//! The feature enables no TLS backend of `reqwest`. Enable one in the host, such as
//! `reqwest = { version = "0.13", features = ["rustls"] }`.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::{Map, json};

use crate::definitions::Definition;
use crate::store::lock;
use crate::{BoxError, Json, Store, Values};

/// The fields of a manifest flag that are part of its definition.
const FIELDS: [&str; 8] = [
    "build",
    "default",
    "description",
    "env",
    "expires",
    "options",
    "public",
    "type",
];

/// An error of [`HttpStore`] or [`Client`]. It never holds the token.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The request failed, or the response is not JSON.
    Request(reqwest::Error),
    /// The remote API returned an error status.
    Status {
        /// The method of the request.
        method: String,
        /// The path of the request, under the URL of the API.
        path: String,
        /// The status of the response.
        status: u16,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => write!(f, "The request to the remote API failed: {error}"),
            Self::Status {
                method,
                path,
                status,
            } => {
                let step = if matches!(status, 401 | 403) {
                    "Set `token` to a token that the remote `authorize` accepts with the access the store needs."
                } else {
                    "Check `url`, and that the remote runtime declares the flag."
                };
                write!(
                    f,
                    "The remote admin API returned {status} for {method} {path}.\n\nTo resolve: {step}"
                )
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(error) => Some(error),
            Self::Status { .. } => None,
        }
    }
}

/// A store over the admin API of another Flargs runtime, such as a central admin service. Reads
/// cache the manifest for `ttl`. Writes go through at once and clear the cache. The remote runtime
/// holds the definitions when it has no flags file.
pub struct HttpStore {
    base: String,
    cache: Mutex<Option<(Instant, Arc<Json>)>>,
    client: reqwest::Client,
    token: Option<String>,
    ttl: Duration,
}

impl HttpStore {
    /// Returns a store over the admin API at `url`, such as `https://api.example.com/.flags`.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            base: url.into().trim_end_matches('/').to_owned(),
            cache: Mutex::default(),
            client: reqwest::Client::new(),
            token: None,
            ttl: Duration::from_secs(5),
        }
    }

    /// Sets the HTTP client. Default: `reqwest::Client::new()`.
    #[must_use]
    pub fn client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }

    /// Sets a bearer token that the remote `authorize` accepts.
    #[must_use]
    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    /// Sets the lifetime of a cached manifest. Default: 5 seconds.
    #[must_use]
    pub const fn ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    async fn manifest(&self) -> Result<Arc<Json>, Error> {
        if let Some((expires_at, manifest)) = lock(&self.cache).clone()
            && Instant::now() < expires_at
        {
            return Ok(manifest);
        }

        let manifest = Arc::new(self.request(Method::GET, "/manifest", None).await?);
        *lock(&self.cache) = Some((Instant::now() + self.ttl, Arc::clone(&manifest)));
        Ok(manifest)
    }

    async fn request(&self, method: Method, path: &str, body: Option<Json>) -> Result<Json, Error> {
        let mut request = self
            .client
            .request(method.clone(), format!("{}{path}", self.base));
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }

        let response = request.send().await.map_err(Error::Request)?;
        if !response.status().is_success() {
            return Err(Error::Status {
                method: method.to_string(),
                path: path.to_owned(),
                status: response.status().as_u16(),
            });
        }
        response.json().await.map_err(Error::Request)
    }

    async fn write(&self, method: Method, path: &str, body: Option<Json>) -> Result<(), BoxError> {
        *lock(&self.cache) = None;
        self.request(method, path, body).await?;
        Ok(())
    }
}

impl Store for HttpStore {
    const DEFINITIONS: bool = true;

    async fn delete(&self, key: &str) -> Result<(), BoxError> {
        self.write(Method::DELETE, &format!("/values/{}", path(key)), None)
            .await
    }

    async fn get(&self, keys: &[String]) -> Result<Map<String, Json>, BoxError> {
        let manifest = self.manifest().await?;
        Ok(keys
            .iter()
            .filter_map(|key| {
                let stored = manifest["flags"][key].get("store")?;
                (!stored.is_null()).then(|| (key.clone(), stored.clone()))
            })
            .collect())
    }

    async fn keys(&self) -> Result<Option<Vec<String>>, BoxError> {
        let manifest = self.manifest().await?;
        let mut keys: Vec<String> = manifest["flags"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, flag)| flag.get("store").is_some_and(|stored| !stored.is_null()))
            .map(|(key, _)| key.clone())
            .collect();
        keys.extend(
            manifest["orphans"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|key| key.as_str().map(str::to_owned)),
        );
        Ok(Some(keys))
    }

    async fn set(&self, key: &str, value: &Json) -> Result<(), BoxError> {
        let body = json!({ "value": value });
        self.write(Method::PUT, &format!("/values/{}", path(key)), Some(body))
            .await
    }

    async fn delete_definition(&self, key: &str) -> Result<(), BoxError> {
        self.write(Method::DELETE, &format!("/definitions/{}", path(key)), None)
            .await
    }

    async fn list_definitions(&self) -> Result<Map<String, Json>, BoxError> {
        let manifest = self.manifest().await?;
        Ok(manifest["flags"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(key, flag)| {
                let definition: Map<String, Json> = flag
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(field, _)| FIELDS.contains(&field.as_str()))
                    .map(|(field, value)| (field.clone(), value.clone()))
                    .collect();
                (key.clone(), Json::Object(definition))
            })
            .collect())
    }

    async fn set_definition(&self, key: &str, definition: &Definition) -> Result<(), BoxError> {
        let body = serde_json::to_value(definition)?;
        self.write(
            Method::PUT,
            &format!("/definitions/{}", path(key)),
            Some(body),
        )
        .await
    }
}

/// A client of the values endpoint of a runtime, for a service that reads the public values of
/// another service.
pub struct Client {
    base: String,
    client: reqwest::Client,
}

impl Client {
    /// Returns a client of the runtime at `url`, such as `https://api.example.com/.flags`.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            base: url.into().trim_end_matches('/').to_owned(),
            client: reqwest::Client::new(),
        }
    }

    /// Sets the HTTP client. Default: `reqwest::Client::new()`.
    #[must_use]
    pub fn client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }

    /// Returns the public values. `overrides` holds `flag.*` search parameters, such as the output
    /// of [`overrides::serialize`](crate::overrides::serialize), or is empty.
    ///
    /// # Errors
    ///
    /// Returns [`Error`] when the request fails or the endpoint returns an error status.
    pub async fn values(&self, overrides: &str) -> Result<Values, Error> {
        let query = if overrides.is_empty() {
            String::new()
        } else {
            format!("?{overrides}")
        };
        let response = self
            .client
            .get(format!("{}/values{query}", self.base))
            .send()
            .await
            .map_err(Error::Request)?;
        if !response.status().is_success() {
            return Err(Error::Status {
                method: "GET".to_owned(),
                path: "/values".to_owned(),
                status: response.status().as_u16(),
            });
        }
        response.json().await.map_err(Error::Request)
    }
}

/// Encodes a key as one path segment, as `encodeURIComponent` does.
fn path(key: &str) -> String {
    crate::runtime::uri_encode(key)
}
