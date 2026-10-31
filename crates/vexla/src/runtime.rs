//! The runtime: resolves flag values for each request in the order override, store value,
//! `decide`, environment, then default. It matches `Runtime.create` in the TypeScript package.

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::fmt::{self, Write as _};
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use http::request::Parts;
use serde_json::Map;

use crate::definitions::{self, Definitions, InvalidValueError};
use crate::overrides::{self, ParseOptions, Signature};
use crate::store::{DynStore, lock};
use crate::{Error, FlagSet, FlagValue, Json, Key, Store, Values};

/// The access of an admin request, as `authorize` returns it.
#[derive(Debug, Default)]
pub enum Access {
    /// No access: the values endpoint only. An admin route returns `401`.
    #[default]
    None,
    /// Admin routes that change no store value and sign no link. A `write` route returns `403`.
    Read,
    /// No access, and an admin route returns this response, such as a `401` challenge.
    Response(http::Response<String>),
    /// Every admin route.
    Write,
}

/// Where a value came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Source {
    /// A `decide` function.
    Decide,
    /// The default of the declaration.
    Default,
    /// The environment variable of the flag.
    Env,
    /// An override from the search parameters or the `vexla` cookie.
    Override,
    /// The store value.
    Store,
}

impl Source {
    /// Returns the source, as the manifest writes it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Decide => "decide",
            Self::Default => "default",
            Self::Env => "env",
            Self::Override => "override",
            Self::Store => "store",
        }
    }
}

type Authorize = Box<dyn Fn(&Parts) -> Access + Send + Sync>;
type Context = dyn Any + Send + Sync;
/// Returns `None` when the context is not the type that the function reads.
type Decide = Box<dyn Fn(&Context) -> Option<Option<Json>> + Send + Sync>;
type Identify = Box<dyn Fn(&Parts) -> Arc<Context> + Send + Sync>;
type OnError = Box<dyn Fn(&Error) + Send + Sync>;

/// The builder of a [`Runtime`], from [`Runtime::builder`]. It mirrors the options of
/// `Runtime.create` in TypeScript.
pub struct Builder<F> {
    authorize: Option<Authorize>,
    cors: Vec<String>,
    decide: HashMap<String, Decide>,
    definitions: Option<Definitions>,
    dev: bool,
    env: Option<BTreeMap<String, String>>,
    flags: PhantomData<fn() -> F>,
    identify: Option<Identify>,
    on_error: Option<OnError>,
    path: String,
    secret: Option<String>,
    store: Option<Box<dyn DynStore>>,
}

impl<F: FlagSet> Builder<F> {
    /// Sets the function that returns the access of an admin request. Default: no access outside
    /// dev mode. In dev mode, every request has [`Access::Write`] and `authorize` does not run.
    #[must_use]
    pub fn authorize(
        mut self,
        authorize: impl Fn(&Parts) -> Access + Send + Sync + 'static,
    ) -> Self {
        self.authorize = Some(Box::new(authorize));
        self
    }

    /// Sets the origins that receive CORS headers on the values endpoint. Admin routes return none.
    #[must_use]
    pub fn cors(mut self, origins: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.cors = origins.into_iter().map(Into::into).collect();
        self
    }

    /// Sets the function that returns the value of `key` from the context of `identify`, or `None`
    /// to fall through. Without `identify`, the context is `()`. A build flag has no [`Key`], so it
    /// accepts no `decide`.
    #[must_use]
    pub fn decide<T: FlagValue + 'static, C: Any + Send + Sync>(
        mut self,
        key: Key<T>,
        decide: impl Fn(&C) -> Option<T> + Send + Sync + 'static,
    ) -> Self {
        let decide: Decide = Box::new(move |context: &Context| {
            let context = context.downcast_ref::<C>()?;
            Some(decide(context).map(|value| value.to_json()))
        });
        self.decide.insert(key.key().to_owned(), decide);
        self
    }

    /// Sets the definitions, such as from [`definitions::parse_file`]. Default: the definitions of
    /// `F`. Without them, the store holds the definitions, or the runtime has no flags.
    #[must_use]
    pub fn definitions(mut self, definitions: Definitions) -> Self {
        self.definitions = Some(definitions);
        self
    }

    /// Sets dev mode: every flag accepts an unsigned override, and the dev route is open. Default:
    /// `false`.
    #[must_use]
    pub const fn dev(mut self, dev: bool) -> Self {
        self.dev = dev;
        self
    }

    /// Sets the environment, whose variable of the same name as a flag sets its value. Default: the
    /// variables of the process when [`Builder::build`] runs.
    #[must_use]
    pub fn env(mut self, env: impl IntoIterator<Item = (String, String)>) -> Self {
        self.env = Some(env.into_iter().collect());
        self
    }

    /// Sets the function that returns the context that `decide` receives, such as the user of the
    /// request.
    #[must_use]
    pub fn identify<C: Any + Send + Sync>(
        mut self,
        identify: impl Fn(&Parts) -> C + Send + Sync + 'static,
    ) -> Self {
        self.identify = Some(Box::new(move |parts| Arc::new(identify(parts))));
        self
    }

    /// Sets the function that receives invalid overrides, store values, `decide` results, and
    /// store errors.
    #[must_use]
    pub fn on_error(mut self, on_error: impl Fn(&Error) + Send + Sync + 'static) -> Self {
        self.on_error = Some(Box::new(on_error));
        self
    }

    /// Sets the path of the dev route and the admin API. Default: `/.flags`.
    #[must_use]
    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.path = path.into();
        self
    }

    /// Sets the HMAC secret for overrides and links, such as `VEXLA_SECRET`. Required outside dev
    /// mode.
    #[must_use]
    pub fn secret(mut self, secret: impl Into<String>) -> Self {
        self.secret = Some(secret.into());
        self
    }

    /// Sets the store for admin values, and optionally for definitions.
    #[must_use]
    pub fn store(mut self, store: impl Store) -> Self {
        self.store = Some(Box::new(store));
        self
    }

    /// Returns the runtime.
    ///
    /// # Errors
    ///
    /// Returns [`Error::MissingSecret`] outside dev mode without `secret`.
    pub fn build(self) -> Result<Runtime<F>, Error> {
        let secret = self.secret.filter(|secret| !secret.is_empty());
        if !self.dev && secret.is_none() {
            return Err(Error::MissingSecret);
        }

        let env = self.env.unwrap_or_else(|| {
            std::env::vars_os()
                .filter_map(|(name, value)| {
                    Some((name.into_string().ok()?, value.into_string().ok()?))
                })
                .collect()
        });

        let origin = match (self.definitions.or_else(F::definitions), &self.store) {
            (Some(definitions), _) => Origin::File(Arc::new(definitions)),
            (None, Some(store)) if store.definitions() => Origin::Store(Mutex::default()),
            (None, _) => Origin::Empty(Arc::default()),
        };

        Ok(Runtime {
            flags: PhantomData,
            inner: Arc::new(Inner {
                authorize: self.authorize,
                cors: self.cors,
                decide: self.decide,
                dev: self.dev,
                env,
                identify: self.identify,
                on_error: self.on_error,
                origin,
                path: self.path.trim_end_matches('/').to_owned(),
                secret,
                store: self.store,
            }),
        })
    }
}

/// The runtime instance. It listens on no port: the `server` feature serves it as a
/// `tower::Service`. A clone shares the instance.
///
/// `F` is the flags of the project, such as the `Flags` struct of `vexla::flags!`, or [`Values`]
/// when the store or the environment holds the definitions.
pub struct Runtime<F = Values> {
    flags: PhantomData<fn() -> F>,
    pub(crate) inner: Arc<Inner>,
}

impl<F> Clone for Runtime<F> {
    fn clone(&self) -> Self {
        Self {
            flags: PhantomData,
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<F> fmt::Debug for Runtime<F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Runtime")
            .field("dev", &self.inner.dev)
            .field("path", &self.inner.path)
            .finish_non_exhaustive()
    }
}

#[cfg_attr(
    not(feature = "server"),
    expect(dead_code, reason = "The `server` feature serves the admin API.")
)]
pub(crate) struct Inner {
    authorize: Option<Authorize>,
    pub(crate) cors: Vec<String>,
    decide: HashMap<String, Decide>,
    pub(crate) dev: bool,
    env: BTreeMap<String, String>,
    identify: Option<Identify>,
    on_error: Option<OnError>,
    pub(crate) origin: Origin,
    pub(crate) path: String,
    pub(crate) secret: Option<String>,
    pub(crate) store: Option<Box<dyn DynStore>>,
}

/// Where the definitions come from.
pub(crate) enum Origin {
    /// No flags file and no store definitions: the runtime has no flags.
    Empty(Arc<Definitions>),
    /// A flags file, or definitions from the builder.
    File(Arc<Definitions>),
    /// The store, read once and again after a definition write through this runtime.
    Store(Mutex<Option<Arc<Definitions>>>),
}

/// The values that a request resolves once: definitions, context, overrides, and store values.
pub(crate) struct State {
    context: Arc<Context>,
    pub(crate) definitions: Arc<Definitions>,
    pub(crate) overrides: Values,
    pub(crate) stored: Map<String, Json>,
}

#[derive(Clone)]
#[cfg_attr(
    not(feature = "server"),
    expect(dead_code, reason = "The `server` feature serves the admin API.")
)]
pub(crate) struct Resolved {
    pub(crate) source: Source,
    pub(crate) value: Json,
}

/// The cache of one request, which the layer of the `server` feature adds to its extensions.
#[derive(Clone)]
pub(crate) struct Cache(Arc<CacheEntry>);

struct CacheEntry {
    runtime: usize,
    state: Mutex<Option<Arc<State>>>,
    values: Mutex<HashMap<String, Resolved>>,
}

impl<F: FlagSet> Runtime<F> {
    /// Returns a builder. Without `definitions`, the runtime reads the definitions of `F`.
    pub fn builder() -> Builder<F> {
        Builder {
            authorize: None,
            cors: Vec::new(),
            decide: HashMap::new(),
            definitions: None,
            dev: false,
            env: None,
            flags: PhantomData,
            identify: None,
            on_error: None,
            path: "/.flags".to_owned(),
            secret: None,
            store: None,
        }
    }

    /// Returns every value for the request.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn evaluate(&self, parts: &Parts) -> Result<F, Error> {
        Ok(F::from_values(&self.values(parts, false).await?))
    }
}

impl<F> Runtime<F> {
    /// Returns the definitions: the flags file, the store definitions, or none.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn definitions(&self) -> Result<Arc<Definitions>, Error> {
        let cache = match &self.inner.origin {
            Origin::Empty(definitions) | Origin::File(definitions) => {
                return Ok(Arc::clone(definitions));
            }
            Origin::Store(cache) => cache,
        };

        if let Some(definitions) = lock(cache).clone() {
            return Ok(definitions);
        }

        let Some(store) = &self.inner.store else {
            return Err(Error::DefinitionsUnavailable("No store.".into()));
        };
        let list = store
            .list_definitions()
            .await
            .map_err(Error::DefinitionsUnavailable)?;
        let definitions = definitions::parse(&Json::Object(list))
            .map_err(|error| Error::DefinitionsUnavailable(error.into()))?;

        let definitions = Arc::new(definitions);
        *lock(cache) = Some(Arc::clone(&definitions));
        Ok(definitions)
    }

    /// Returns one value for the request, and runs `decide` for that flag only.
    ///
    /// # Errors
    ///
    /// Returns [`Error::UnknownFlag`] when no definition declares the key,
    /// [`Error::InvalidValue`] when the definition has another type than the key, and
    /// [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn get<T: FlagValue>(&self, parts: &Parts, key: Key<T>) -> Result<T, Error> {
        let resolved = self.resolve(parts, key.key()).await?;
        T::from_json(&resolved.value).ok_or_else(|| {
            Error::InvalidValue(InvalidValueError {
                key: key.key().to_owned(),
                r#type: self.type_of(key.key()).unwrap_or(definitions::Type::Json),
            })
        })
    }

    /// Returns the path of the dev route and the admin API.
    pub fn path(&self) -> &str {
        &self.inner.path
    }

    /// Returns a `<script>` element with the public values for the request, for the HTML of a page.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn script(&self, parts: &Parts) -> Result<String, Error> {
        let values = self.values(parts, true).await?;
        Ok(format!(
            r#"<script type="application/json" id="__vexla">{}</script>"#,
            safe_json(&serde_json::to_value(values).unwrap_or_default())
        ))
    }

    /// Returns the `Set-Cookie` value that stores the overrides in the search parameters of the
    /// request, if any.
    ///
    /// # Errors
    ///
    /// Returns [`Error::DefinitionsUnavailable`] when the store cannot return the definitions.
    pub async fn set_cookie(&self, parts: &Parts) -> Result<Option<String>, Error> {
        let query = parts.uri.query().unwrap_or_default();
        if !overrides::form_decode(query)
            .iter()
            .any(|param| param.0.starts_with(overrides::PREFIX))
        {
            return Ok(None);
        }

        let state = self.state(parts).await?;
        Ok(Some(self.cookie(&state.overrides)))
    }

    #[cfg_attr(
        not(feature = "server"),
        expect(dead_code, reason = "The `server` feature serves the admin API.")
    )]
    pub(crate) fn authorize(&self, parts: &Parts) -> Access {
        if self.inner.dev {
            return Access::Write;
        }
        self.inner
            .authorize
            .as_ref()
            .map_or(Access::None, |authorize| authorize(parts))
    }

    #[cfg_attr(
        not(feature = "server"),
        expect(dead_code, reason = "The `server` feature serves the admin API.")
    )]
    pub(crate) fn cache(&self) -> Cache {
        Cache(Arc::new(CacheEntry {
            runtime: self.id(),
            state: Mutex::default(),
            values: Mutex::default(),
        }))
    }

    /// Returns the `Set-Cookie` value that stores `overrides`, or clears the cookie when it is empty.
    pub(crate) fn cookie(&self, overrides: &Values) -> String {
        let secure = if self.inner.dev { "" } else { "; Secure" };
        if overrides.is_empty() {
            return format!(
                "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}",
                overrides::COOKIE
            );
        }

        let max_age: i64 = 30 * 24 * 60 * 60;
        let signature = self.inner.secret.as_deref().map(|secret| Signature {
            expires_at: now() + max_age * 1000,
            secret,
        });
        let params = overrides::serialize(overrides, signature.as_ref());
        format!(
            "{}={}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
            overrides::COOKIE,
            uri_encode(&params)
        )
    }

    /// Clears the cached store definitions, after a definition write.
    #[cfg_attr(
        not(feature = "server"),
        expect(dead_code, reason = "The `server` feature serves the admin API.")
    )]
    pub(crate) fn invalidate(&self) {
        if let Origin::Store(cache) = &self.inner.origin {
            *lock(cache) = None;
        }
    }

    pub(crate) fn report(&self, error: &Error) {
        if let Some(on_error) = &self.inner.on_error {
            on_error(error);
        }
    }

    pub(crate) async fn resolve(&self, parts: &Parts, key: &str) -> Result<Resolved, Error> {
        let cache = self.find_cache(parts);
        if let Some(resolved) = cache.and_then(|cache| lock(&cache.0.values).get(key).cloned()) {
            return Ok(resolved);
        }

        let state = self.state(parts).await?;
        let resolved = self.compute(&state, key)?;

        if let Some(cache) = cache {
            lock(&cache.0.values).insert(key.to_owned(), resolved.clone());
        }
        Ok(resolved)
    }

    pub(crate) async fn state(&self, parts: &Parts) -> Result<Arc<State>, Error> {
        let cache = self.find_cache(parts);
        if let Some(state) = cache.and_then(|cache| lock(&cache.0.state).clone()) {
            return Ok(state);
        }

        let definitions = self.definitions().await?;
        let overrides = self.read_overrides(parts, &definitions);
        let keys: Vec<String> = definitions.keys().cloned().collect();
        let stored = match &self.inner.store {
            Some(store) => store.get(&keys).await.unwrap_or_else(|error| {
                self.report(&Error::Store(error));
                Map::new()
            }),
            None => Map::new(),
        };
        let context = self
            .inner
            .identify
            .as_ref()
            .map_or_else(|| Arc::new(()) as Arc<Context>, |identify| identify(parts));

        let state = Arc::new(State {
            context,
            definitions,
            overrides,
            stored,
        });
        if let Some(cache) = cache {
            *lock(&cache.0.state) = Some(Arc::clone(&state));
        }
        Ok(state)
    }

    /// Returns the values for the request. With `public`, it returns public flags only.
    pub(crate) async fn values(&self, parts: &Parts, public: bool) -> Result<Values, Error> {
        let state = self.state(parts).await?;
        let mut values = Values::new();

        for (key, definition) in state.definitions.iter() {
            if public && !definition.public {
                continue;
            }
            values.insert(key.clone(), self.resolve(parts, key).await?.value);
        }

        Ok(values)
    }

    fn compute(&self, state: &State, key: &str) -> Result<Resolved, Error> {
        let Some(definition) = state.definitions.get(key) else {
            return Err(Error::UnknownFlag {
                key: key.to_owned(),
            });
        };
        let invalid = || {
            Error::InvalidValue(InvalidValueError {
                key: key.to_owned(),
                r#type: definition.r#type,
            })
        };

        if let Some(value) = state.overrides.get(key) {
            return Ok(Resolved {
                source: Source::Override,
                value: value.clone(),
            });
        }

        let fallback = match self.inner.env.get(key) {
            None => Resolved {
                source: Source::Default,
                value: definition.default.clone(),
            },
            Some(raw) => match definitions::decode(definition, raw, key) {
                Ok(value) => Resolved {
                    source: Source::Env,
                    value,
                },
                Err(error) => {
                    self.report(&Error::InvalidValue(error));
                    Resolved {
                        source: Source::Default,
                        value: definition.default.clone(),
                    }
                }
            },
        };

        if let Some(stored) = state.stored.get(key) {
            if let Some(value) = coerce(definition, stored, key) {
                return Ok(Resolved {
                    source: Source::Store,
                    value,
                });
            }
            self.report(&invalid());
        }

        if definition.build {
            return Ok(fallback);
        }

        if let Some(decide) = self.inner.decide.get(key) {
            match decide(state.context.as_ref()) {
                None => self.report(&Error::Context {
                    key: key.to_owned(),
                }),
                Some(None) => {}
                Some(Some(value)) if definitions::validate(definition, &value) => {
                    return Ok(Resolved {
                        source: Source::Decide,
                        value,
                    });
                }
                Some(Some(_)) => self.report(&invalid()),
            }
        }

        Ok(fallback)
    }

    fn type_of(&self, key: &str) -> Option<definitions::Type> {
        match &self.inner.origin {
            Origin::Empty(definitions) | Origin::File(definitions) => {
                definitions.get(key).map(|definition| definition.r#type)
            }
            Origin::Store(cache) => lock(cache)
                .as_ref()
                .and_then(|definitions| definitions.get(key).map(|definition| definition.r#type)),
        }
    }

    fn find_cache<'a>(&self, parts: &'a Parts) -> Option<&'a Cache> {
        parts
            .extensions
            .get::<Cache>()
            .filter(|cache| cache.0.runtime == self.id())
    }

    fn id(&self) -> usize {
        Arc::as_ptr(&self.inner).addr()
    }

    fn read_overrides(&self, parts: &Parts, definitions: &Definitions) -> Values {
        let options = ParseOptions {
            definitions,
            dev: self.inner.dev,
            now: now(),
            secret: self.inner.secret.as_deref(),
        };
        let mut result = Values::new();

        // The cookie holds overrides that this runtime wrote, so a valid cookie applies to private flags.
        if let Some(raw) = read_cookie(parts, overrides::COOKIE) {
            match overrides::parse(&raw, &options) {
                Ok(parsed) => {
                    if parsed.signed || self.inner.dev {
                        result.extend(parsed.values);
                    }
                    for error in parsed.errors {
                        self.report(&Error::Override(error));
                    }
                }
                Err(error) => self.report(&Error::InvalidSignature(error)),
            }
        }

        // Search parameters take precedence over the cookie.
        match overrides::parse(parts.uri.query().unwrap_or_default(), &options) {
            Ok(parsed) => {
                if parsed.reset {
                    result.clear();
                }
                result.extend(parsed.values);
                for error in parsed.errors {
                    self.report(&Error::Override(error));
                }
            }
            Err(error) => self.report(&Error::InvalidSignature(error)),
        }

        result
    }
}

/// Returns the milliseconds since the epoch.
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

/// Returns `value` as JSON that a `<script>` element can hold: `<`, `>`, `&`, U+2028, and U+2029
/// are escaped, so a value cannot close the element or start a comment.
pub(crate) fn safe_json(value: &Json) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Encodes text as `encodeURIComponent` does.
pub(crate) fn uri_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());

    for byte in text.bytes() {
        match byte {
            b'!'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z' => encoded.push(char::from(byte)),
            _ => {
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }

    encoded
}

// A store over environment variables holds text, so text decodes for a non-string flag.
fn coerce(definition: &definitions::Definition, value: &Json, key: &str) -> Option<Json> {
    if definitions::validate(definition, value) {
        return Some(value.clone());
    }
    definitions::decode(definition, value.as_str()?, key).ok()
}

fn read_cookie(parts: &Parts, name: &str) -> Option<String> {
    parts
        .headers
        .get_all(http::header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key.trim() == name).then(|| overrides::percent_decode(value.trim(), false))
        })
}
