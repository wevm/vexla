//! The `axum` feature: the [`Flags`] extractor, which reads the runtime that
//! [`Runtime::layer`](crate::Runtime::layer) adds to each request.

use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::request::Parts;

use crate::{Error, FlagSet, FlagValue, Key, Runtime};

/// The flag operations of one request. The values resolve once for each request, so two reads of
/// a flag run `decide` once.
///
/// ```ignore
/// async fn checkout(flags: flargs::axum::Flags<Flags>) -> Result<Response, flargs::Error> {
///     Ok(if flags.get(Flags::NEW_CHECKOUT).await? { new_checkout() } else { checkout_page() })
/// }
/// ```
pub struct Flags<F> {
    parts: Parts,
    runtime: Runtime<F>,
}

impl<F: FlagSet> Flags<F> {
    /// Returns every value for the request, as [`Runtime::evaluate`] does.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn evaluate(&self) -> Result<F, Error> {
        self.runtime.evaluate(&self.parts).await
    }

    /// Returns one value for the request, as [`Runtime::get`] does.
    ///
    /// # Errors
    ///
    /// Returns the errors of [`Runtime::get`].
    pub async fn get<T: FlagValue>(&self, key: Key<T>) -> Result<T, Error> {
        self.runtime.get(&self.parts, key).await
    }

    /// Returns the `<script>` element of the public values, as [`Runtime::script`] does.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn script(&self) -> Result<String, Error> {
        self.runtime.script(&self.parts).await
    }
}

impl<F: 'static, S: Send + Sync> FromRequestParts<S> for Flags<F> {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let runtime = parts.extensions.get::<Runtime<F>>().cloned().ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "flargs::axum::Flags needs `Runtime::layer` on the router.",
        ))?;
        Ok(Self {
            parts: parts.clone(),
            runtime,
        })
    }
}

/// Returns `503` when the definitions are unavailable, and `500` for another error. The body holds
/// no detail of the error.
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Self::DefinitionsUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        status.into_response()
    }
}
