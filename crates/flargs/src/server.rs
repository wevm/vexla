//! The `server` feature: the dev route and the admin API as a `tower::Service`, and a
//! `tower::Layer` that serves them, caches flag values for each request, and stores override
//! search parameters in the `flargs` cookie. Routes, access rules, and status codes match
//! `runtime.fetch` in the TypeScript package.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::header::{
    ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE, HOST,
    ORIGIN, SET_COOKIE, VARY,
};
use http::request::Parts;
use http::{HeaderValue, Method, Request, Response, StatusCode, Uri};
use http_body::Body;
use http_body_util::{BodyExt as _, Either, Full, Limited};
use serde_json::{Map, json};

use crate::definitions::{self, Definition};
use crate::overrides::{self, Signature};
use crate::runtime::{Access, Origin, Runtime, now, safe_json};
use crate::{BoxError, Error, Json};

/// The dev route page. It is a copy of the output of `src/server/internal/Page.ts`, with
/// `{{config}}` in place of the configuration. Change both files together.
const PAGE: &str = include_str!("server/page.html.tmpl");

/// The largest request body that the admin API reads, in bytes.
const BODY_LIMIT: usize = 1 << 20;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

impl<F> Runtime<F> {
    /// Returns a `tower::Service` that serves the dev route and the admin API under the path, and
    /// returns `404` outside it. Under `axum::Router::nest_service`, it reads the path of the
    /// original URI.
    pub fn service(&self) -> Service<F> {
        Service {
            runtime: self.clone(),
        }
    }

    /// Returns a `tower::Layer` that serves the path as [`Runtime::service`] does, caches flag
    /// values for each other request, and adds a `Set-Cookie` header when the request holds
    /// override search parameters. The `axum` extractor reads the runtime from it.
    pub fn layer(&self) -> Layer<F> {
        Layer {
            runtime: self.clone(),
        }
    }

    pub(crate) fn serves(&self, parts: &Parts) -> Option<String> {
        let route = original_uri(parts)
            .path()
            .strip_prefix(self.inner.path.as_str())?
            .to_owned();
        (route.is_empty() || route.starts_with('/')).then_some(route)
    }

    async fn handle<B>(&self, parts: &Parts, body: B) -> Response<Full<Bytes>>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        let Some(route) = self.serves(parts) else {
            return reply(StatusCode::NOT_FOUND, &json!({ "error": "not_found" }));
        };
        let route = route.strip_prefix('/').unwrap_or(&route);
        let segments: Vec<String> = if route.is_empty() {
            Vec::new()
        } else {
            route
                .split('/')
                .map(|segment| overrides::percent_decode(segment, false))
                .collect()
        };

        match self.route(parts, &segments, body).await {
            Ok(response) => response,
            Err(Error::DefinitionsUnavailable(error)) => {
                self.report(&Error::DefinitionsUnavailable(error));
                reply(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &json!({ "error": "definitions_unavailable" }),
                )
            }
            Err(error) => {
                self.report(&error);
                reply(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &json!({ "error": "internal_error" }),
                )
            }
        }
    }

    async fn route<B>(
        &self,
        parts: &Parts,
        segments: &[String],
        body: B,
    ) -> Result<Response<Full<Bytes>>, Error>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        let method = &parts.method;
        let segments: Vec<&str> = segments.iter().map(String::as_str).collect();

        // The values endpoint is public, and returns public flags only.
        if segments == ["values"] {
            let origin = self.cors(parts);
            if method == Method::OPTIONS {
                let mut response = Response::new(Full::default());
                *response.status_mut() = StatusCode::NO_CONTENT;
                return Ok(with_cors(response, origin));
            }
            if method != Method::GET {
                return Ok(not_allowed());
            }
            let values = self.values(parts, true).await?;
            return Ok(with_cors(reply(StatusCode::OK, &json!(values)), origin));
        }

        let write = match self.authorize(parts) {
            Access::None => {
                return Ok(reply(
                    StatusCode::UNAUTHORIZED,
                    &json!({ "error": "unauthorized" }),
                ));
            }
            Access::Read => false,
            Access::Response(response) => return Ok(response.map(Full::from)),
            Access::Write => true,
        };

        let required = !matches!(segments.first(), None | Some(&"manifest" | &"overrides"));
        if required && !write {
            return Ok(reply(
                StatusCode::FORBIDDEN,
                &json!({ "error": "forbidden" }),
            ));
        }

        match segments.as_slice() {
            [] => {
                if method != Method::GET {
                    return Ok(not_allowed());
                }
                let config = safe_json(&json!({ "path": self.inner.path, "write": write }));
                let mut response = Response::new(Full::from(PAGE.replace("{{config}}", &config)));
                let headers = response.headers_mut();
                headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
                headers.insert(
                    CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                );
                Ok(response)
            }
            ["manifest"] => {
                if method != Method::GET {
                    return Ok(not_allowed());
                }
                self.manifest(parts).await
            }
            ["values", key] => self.write_value(method, key, body).await,
            ["definitions", key] => self.write_definition(method, key, body).await,
            ["overrides"] => self.write_overrides(method, body).await,
            ["links"] => self.link(parts, body).await,
            _ => Ok(reply(
                StatusCode::NOT_FOUND,
                &json!({ "error": "not_found" }),
            )),
        }
    }

    fn cors(&self, parts: &Parts) -> Option<HeaderValue> {
        let origin = parts.headers.get(ORIGIN)?;
        let allowed = self
            .inner
            .cors
            .iter()
            .any(|allowed| allowed.as_bytes() == origin.as_bytes());
        allowed.then(|| origin.clone())
    }

    async fn link<B>(&self, parts: &Parts, body: B) -> Result<Response<Full<Bytes>>, Error>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        if parts.method != Method::POST {
            return Ok(not_allowed());
        }
        let Some(secret) = self.inner.secret.as_deref() else {
            return Ok(reply(
                StatusCode::NOT_IMPLEMENTED,
                &json!({ "error": "no_secret" }),
            ));
        };

        let body = read_json(body).await.unwrap_or_default();
        let (Some(Json::Object(input)), Some(Json::String(target)), Some(expires_at)) = (
            body.get("values"),
            body.get("url"),
            body.get("expiresAt").and_then(Json::as_f64),
        ) else {
            return Ok(invalid_body());
        };

        let definitions = self.definitions().await?;
        let mut values = crate::Values::new();
        for (key, value) in input {
            let Some(definition) = definitions.get(key) else {
                return Ok(keyed(StatusCode::NOT_FOUND, "unknown_flag", key));
            };
            if definition.build {
                return Ok(keyed(StatusCode::BAD_REQUEST, "build_flag", key));
            }
            if !definitions::validate(definition, value) {
                return Ok(keyed(StatusCode::BAD_REQUEST, "invalid_value", key));
            }
            values.insert(key.clone(), value.clone());
        }

        #[expect(
            clippy::cast_possible_truncation,
            reason = "A JSON number of milliseconds since the epoch fits in i64."
        )]
        let expires_at = expires_at as i64;
        let params = overrides::serialize(&values, Some(&Signature { expires_at, secret }));
        let url = link(parts, target, &params);
        Ok(reply(StatusCode::OK, &json!({ "url": url })))
    }

    async fn manifest(&self, parts: &Parts) -> Result<Response<Full<Bytes>>, Error> {
        let state = self.state(parts).await?;
        let mut flags = Map::new();

        for (key, definition) in state.definitions.iter() {
            let resolved = self.resolve(parts, key).await?;
            let mut entry = match serde_json::to_value(definition) {
                Ok(Json::Object(entry)) => entry,
                _ => Map::new(),
            };
            entry.insert(
                "override".to_owned(),
                state.overrides.get(key).cloned().unwrap_or_default(),
            );
            entry.insert("source".to_owned(), json!(resolved.source.as_str()));
            entry.insert(
                "stale".to_owned(),
                json!(definitions::is_stale(definition, now())),
            );
            entry.insert(
                "store".to_owned(),
                state.stored.get(key).cloned().unwrap_or_default(),
            );
            entry.insert("value".to_owned(), resolved.value);
            flags.insert(key.clone(), Json::Object(entry));
        }

        let orphans = match &self.inner.store {
            Some(store) => store.keys().await.map_err(Error::Store)?.map(|keys| {
                let mut orphans: Vec<String> = keys
                    .into_iter()
                    .filter(|key| !state.definitions.contains_key(key))
                    .collect();
                orphans.sort();
                orphans
            }),
            None => None,
        };

        Ok(reply(
            StatusCode::OK,
            &json!({
                "flags": flags,
                "orphans": orphans,
                "store": self.inner.store.is_some(),
                "storeDefinitions": matches!(self.inner.origin, Origin::Store(_)),
                "version": 1,
            }),
        ))
    }

    async fn write_definition<B>(
        &self,
        method: &Method,
        key: &str,
        body: B,
    ) -> Result<Response<Full<Bytes>>, Error>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        match (&self.inner.origin, &self.inner.store) {
            (Origin::File(_), _) => Ok(reply(
                StatusCode::CONFLICT,
                &json!({ "error": "definitions_in_file" }),
            )),
            (Origin::Store(_), Some(store)) => {
                if method == Method::DELETE {
                    store.delete_definition(key).await.map_err(Error::Store)?;
                    self.invalidate();
                    return Ok(reply(StatusCode::OK, &json!({ "key": key })));
                }
                if method != Method::PUT {
                    return Ok(not_allowed());
                }

                let body = read_json(body).await.map(Json::Object).unwrap_or_default();
                let mut input = Map::new();
                input.insert(key.to_owned(), body);
                let parsed: Result<Definition, String> =
                    match definitions::parse(&Json::Object(input)) {
                        Ok(mut parsed) => parsed
                            .remove(key)
                            .ok_or_else(|| "Invalid definition.".to_owned()),
                        Err(error) => Err(error.reason),
                    };
                let definition = match parsed {
                    Ok(definition) => definition,
                    Err(message) => {
                        return Ok(reply(
                            StatusCode::BAD_REQUEST,
                            &json!({ "error": "invalid_definition", "message": message }),
                        ));
                    }
                };

                store
                    .set_definition(key, &definition)
                    .await
                    .map_err(Error::Store)?;
                self.invalidate();
                Ok(reply(
                    StatusCode::OK,
                    &json!({ "definition": definition, "key": key }),
                ))
            }
            _ => Ok(reply(
                StatusCode::NOT_IMPLEMENTED,
                &json!({ "error": "no_store_definitions" }),
            )),
        }
    }

    async fn write_overrides<B>(
        &self,
        method: &Method,
        body: B,
    ) -> Result<Response<Full<Bytes>>, Error>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        if method == Method::DELETE {
            let cookie = self.cookie(&crate::Values::new());
            return Ok(with_cookie(reply(StatusCode::OK, &json!({})), &cookie));
        }
        if method != Method::PUT {
            return Ok(not_allowed());
        }

        let body = read_json(body).await.unwrap_or_default();
        let Some(Json::Object(input)) = body.get("values") else {
            return Ok(invalid_body());
        };

        // An admin request may preview private flags, so overrides from this route count as signed.
        let definitions = self.definitions().await?;
        let mut accepted = crate::Values::new();
        for (key, value) in input {
            let Some(definition) = definitions.get(key) else {
                return Ok(keyed(StatusCode::NOT_FOUND, "unknown_flag", key));
            };
            if definition.build && !self.inner.dev {
                return Ok(keyed(StatusCode::BAD_REQUEST, "build_flag", key));
            }
            if !definitions::validate(definition, value) {
                return Ok(keyed(StatusCode::BAD_REQUEST, "invalid_value", key));
            }
            accepted.insert(key.clone(), value.clone());
        }

        let cookie = self.cookie(&accepted);
        Ok(with_cookie(
            reply(StatusCode::OK, &json!({ "values": accepted })),
            &cookie,
        ))
    }

    async fn write_value<B>(
        &self,
        method: &Method,
        key: &str,
        body: B,
    ) -> Result<Response<Full<Bytes>>, Error>
    where
        B: Body,
        B::Error: Into<BoxError>,
    {
        let Some(store) = &self.inner.store else {
            return Ok(reply(
                StatusCode::NOT_IMPLEMENTED,
                &json!({ "error": "no_store" }),
            ));
        };
        let definitions = self.definitions().await?;
        let definition = definitions.get(key);

        // An orphan value, of a flag that no longer exists, may be deleted.
        if method == Method::DELETE {
            let exists = match definition {
                Some(_) => true,
                None => store
                    .keys()
                    .await
                    .map_err(Error::Store)?
                    .is_some_and(|keys| keys.iter().any(|stored| stored == key)),
            };
            if exists {
                store.delete(key).await.map_err(Error::Store)?;
                return Ok(reply(StatusCode::OK, &json!({ "key": key })));
            }
        }
        let Some(definition) = definition else {
            return Ok(reply(
                StatusCode::NOT_FOUND,
                &json!({ "error": "unknown_flag" }),
            ));
        };
        if method != Method::PUT {
            return Ok(not_allowed());
        }

        let body = read_json(body).await.unwrap_or_default();
        let Some(value) = body
            .get("value")
            .filter(|value| definitions::validate(definition, value))
        else {
            return Ok(keyed(StatusCode::BAD_REQUEST, "invalid_value", key));
        };

        store.set(key, value).await.map_err(Error::Store)?;
        Ok(reply(
            StatusCode::OK,
            &json!({ "key": key, "value": value }),
        ))
    }
}

/// The `tower::Service` of [`Runtime::service`].
pub struct Service<F> {
    runtime: Runtime<F>,
}

impl<F> Clone for Service<F> {
    fn clone(&self) -> Self {
        Self {
            runtime: self.runtime.clone(),
        }
    }
}

impl<F, B> tower_service::Service<Request<B>> for Service<F>
where
    B: Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<BoxError>,
    F: 'static,
{
    type Error = Infallible;
    type Future = BoxFuture<Result<Self::Response, Self::Error>>;
    type Response = Response<Full<Bytes>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let runtime = self.runtime.clone();
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            Ok(runtime.handle(&parts, body).await)
        })
    }
}

/// The `tower::Layer` of [`Runtime::layer`].
pub struct Layer<F> {
    runtime: Runtime<F>,
}

impl<F> Clone for Layer<F> {
    fn clone(&self) -> Self {
        Self {
            runtime: self.runtime.clone(),
        }
    }
}

impl<S, F> tower_layer::Layer<S> for Layer<F> {
    type Service = Middleware<S, F>;

    fn layer(&self, inner: S) -> Self::Service {
        Middleware {
            inner,
            runtime: self.runtime.clone(),
        }
    }
}

/// The service of [`Layer`] around an inner service.
pub struct Middleware<S, F> {
    inner: S,
    runtime: Runtime<F>,
}

impl<S: Clone, F> Clone for Middleware<S, F> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            runtime: self.runtime.clone(),
        }
    }
}

impl<S, F, B, R> tower_service::Service<Request<B>> for Middleware<S, F>
where
    S: tower_service::Service<Request<B>, Response = Response<R>> + Clone + Send + 'static,
    S::Future: Send,
    B: Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<BoxError>,
    F: 'static,
    R: Send,
{
    type Error = S::Error;
    type Future = BoxFuture<Result<Self::Response, Self::Error>>;
    type Response = Response<Either<Full<Bytes>, R>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        // The ready inner service handles this request, and a fresh clone takes its place.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let runtime = self.runtime.clone();

        Box::pin(async move {
            let (mut parts, body) = request.into_parts();
            if runtime.serves(&parts).is_some() {
                return Ok(runtime.handle(&parts, body).await.map(Either::Left));
            }

            parts.extensions.insert(runtime.cache());
            parts.extensions.insert(runtime.clone());
            let head = parts.uri.query().is_some().then(|| parts.clone());

            let mut response = inner
                .call(Request::from_parts(parts, body))
                .await?
                .map(Either::Right);

            if let Some(head) = head {
                match runtime.set_cookie(&head).await {
                    Ok(Some(cookie)) => {
                        if let Ok(value) = HeaderValue::from_str(&cookie) {
                            response.headers_mut().append(SET_COOKIE, value);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => runtime.report(&error),
                }
            }
            Ok(response)
        })
    }
}

fn invalid_body() -> Response<Full<Bytes>> {
    reply(StatusCode::BAD_REQUEST, &json!({ "error": "invalid_body" }))
}

fn keyed(status: StatusCode, error: &str, key: &str) -> Response<Full<Bytes>> {
    reply(status, &json!({ "error": error, "key": key }))
}

/// Returns `target` with the override parameters `params` set, resolved against the origin of the
/// request, as `new URL(target, request.url)` does for an absolute URL or an absolute path.
fn link(parts: &Parts, target: &str, params: &str) -> String {
    let (rest, fragment) = match target.split_once('#') {
        Some((rest, fragment)) => (rest, Some(fragment)),
        None => (target, None),
    };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));

    let base = if let Some((scheme, after)) = path.split_once("://") {
        if after.contains('/') {
            path.to_owned()
        } else {
            format!("{scheme}://{after}/")
        }
    } else {
        let uri = original_uri(parts);
        let scheme = uri
            .scheme_str()
            .or_else(|| {
                parts
                    .headers
                    .get("x-forwarded-proto")
                    .and_then(|value| value.to_str().ok())
            })
            .unwrap_or("http");
        let host = uri
            .authority()
            .map(|authority| authority.as_str().to_owned())
            .or_else(|| {
                parts
                    .headers
                    .get(HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "localhost".to_owned());
        let slash = if path.starts_with('/') { "" } else { "/" };
        format!("{scheme}://{host}{slash}{path}")
    };

    // As `URLSearchParams.set`: a parameter replaces the first of its name, and drops the rest.
    let mut merged = overrides::form_decode(query);
    for (name, value) in overrides::form_decode(params) {
        match merged.iter().position(|param| param.0 == name) {
            Some(index) => {
                if let Some(param) = merged.get_mut(index) {
                    param.1 = value;
                }
                let mut seen = 0;
                merged.retain(|param| {
                    if param.0 != name {
                        return true;
                    }
                    seen += 1;
                    seen == 1
                });
            }
            None => merged.push((name, value)),
        }
    }

    let query = merged
        .iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                overrides::form_encode(name),
                overrides::form_encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    let mut url = base;
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query);
    }
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

fn not_allowed() -> Response<Full<Bytes>> {
    reply(
        StatusCode::METHOD_NOT_ALLOWED,
        &json!({ "error": "method_not_allowed" }),
    )
}

/// Returns the URI before `axum::Router::nest_service` stripped its prefix.
fn original_uri(parts: &Parts) -> &Uri {
    #[cfg(feature = "axum")]
    if let Some(original) = parts.extensions.get::<axum::extract::OriginalUri>() {
        return &original.0;
    }
    &parts.uri
}

async fn read_json<B>(body: B) -> Option<Map<String, Json>>
where
    B: Body,
    B::Error: Into<BoxError>,
{
    let bytes = Limited::new(body, BODY_LIMIT)
        .collect()
        .await
        .ok()?
        .to_bytes();
    match serde_json::from_slice(&bytes).ok()? {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn reply(status: StatusCode, body: &Json) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::from(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn with_cookie(mut response: Response<Full<Bytes>>, cookie: &str) -> Response<Full<Bytes>> {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    response
}

fn with_cors(
    mut response: Response<Full<Bytes>>,
    origin: Option<HeaderValue>,
) -> Response<Full<Bytes>> {
    if let Some(origin) = origin {
        let headers = response.headers_mut();
        headers.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, OPTIONS"),
        );
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(VARY, HeaderValue::from_static("origin"));
    }
    response
}
