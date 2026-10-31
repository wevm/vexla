//! Stores: where the admin API keeps flag values, and optionally flag definitions, so a value
//! applies to every request. A host implements [`Store`] on its own database.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Map;

use crate::Json;
use crate::definitions::Definition;

/// A boxed error of a store or an HTTP client.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The store contract. A host implements it on its own database, such as a Postgres table.
///
/// Implement each operation with `async fn`. The futures must be `Send`, so a runtime serves
/// requests on a multithreaded executor.
pub trait Store: Send + Sync + 'static {
    /// `true` when the store holds the definitions, so a runtime with no flags file reads them from
    /// [`Store::list_definitions`]. The definition operations run only when it is `true`.
    const DEFINITIONS: bool = false;

    /// Deletes the value of a flag.
    fn delete(&self, key: &str) -> impl Future<Output = Result<(), BoxError>> + Send;

    /// Returns the values of `keys` that the store holds. A key with no value is absent.
    fn get(
        &self,
        keys: &[String],
    ) -> impl Future<Output = Result<Map<String, Json>, BoxError>> + Send;

    /// Returns every key that holds a value, or `None` when the store cannot list them. The
    /// manifest lists orphan values from it.
    fn keys(&self) -> impl Future<Output = Result<Option<Vec<String>>, BoxError>> + Send {
        async { Ok(None) }
    }

    /// Sets the value of a flag. The runtime validates `value` before the call.
    fn set(&self, key: &str, value: &Json) -> impl Future<Output = Result<(), BoxError>> + Send;

    /// Deletes the definition of a flag, and its value.
    fn delete_definition(&self, key: &str) -> impl Future<Output = Result<(), BoxError>> + Send {
        let _ = key;
        async { Err(unsupported()) }
    }

    /// Returns every definition, in the format of a flags file.
    fn list_definitions(&self) -> impl Future<Output = Result<Map<String, Json>, BoxError>> + Send {
        async { Err(unsupported()) }
    }

    /// Creates or replaces the definition of a flag. The runtime validates `definition` before the
    /// call.
    fn set_definition(
        &self,
        key: &str,
        definition: &Definition,
    ) -> impl Future<Output = Result<(), BoxError>> + Send {
        let _ = (key, definition);
        async { Err(unsupported()) }
    }
}

/// A store in memory, for dev mode and tests. It holds values and definitions.
#[derive(Debug, Default)]
pub struct MemoryStore {
    definitions: Mutex<Map<String, Json>>,
    values: Mutex<BTreeMap<String, Json>>,
}

impl MemoryStore {
    /// Returns an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a store that starts with `values`.
    pub fn with_values(values: impl IntoIterator<Item = (String, Json)>) -> Self {
        Self {
            definitions: Mutex::default(),
            values: Mutex::new(values.into_iter().collect()),
        }
    }

    /// Returns a store that starts with `definitions`, in the format of a flags file.
    pub fn with_definitions(definitions: Map<String, Json>) -> Self {
        Self {
            definitions: Mutex::new(definitions),
            values: Mutex::default(),
        }
    }
}

impl Store for MemoryStore {
    const DEFINITIONS: bool = true;

    async fn delete(&self, key: &str) -> Result<(), BoxError> {
        lock(&self.values).remove(key);
        Ok(())
    }

    async fn get(&self, keys: &[String]) -> Result<Map<String, Json>, BoxError> {
        let values = lock(&self.values);
        Ok(keys
            .iter()
            .filter_map(|key| values.get(key).map(|value| (key.clone(), value.clone())))
            .collect())
    }

    async fn keys(&self) -> Result<Option<Vec<String>>, BoxError> {
        Ok(Some(lock(&self.values).keys().cloned().collect()))
    }

    async fn set(&self, key: &str, value: &Json) -> Result<(), BoxError> {
        lock(&self.values).insert(key.to_owned(), value.clone());
        Ok(())
    }

    async fn delete_definition(&self, key: &str) -> Result<(), BoxError> {
        lock(&self.definitions).remove(key);
        lock(&self.values).remove(key);
        Ok(())
    }

    async fn list_definitions(&self) -> Result<Map<String, Json>, BoxError> {
        Ok(lock(&self.definitions).clone())
    }

    async fn set_definition(&self, key: &str, definition: &Definition) -> Result<(), BoxError> {
        let json = serde_json::to_value(definition)?;
        lock(&self.definitions).insert(key.to_owned(), json);
        Ok(())
    }
}

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The object-safe form of [`Store`], which the runtime holds as `Box<dyn DynStore>`.
#[cfg_attr(
    not(feature = "server"),
    expect(dead_code, reason = "The `server` feature serves the admin API.")
)]
pub(crate) trait DynStore: Send + Sync {
    fn definitions(&self) -> bool;
    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), BoxError>>;
    fn get<'a>(&'a self, keys: &'a [String]) -> BoxFuture<'a, Result<Map<String, Json>, BoxError>>;
    fn keys(&self) -> BoxFuture<'_, Result<Option<Vec<String>>, BoxError>>;
    fn set<'a>(&'a self, key: &'a str, value: &'a Json) -> BoxFuture<'a, Result<(), BoxError>>;
    fn delete_definition<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), BoxError>>;
    fn list_definitions(&self) -> BoxFuture<'_, Result<Map<String, Json>, BoxError>>;
    fn set_definition<'a>(
        &'a self,
        key: &'a str,
        definition: &'a Definition,
    ) -> BoxFuture<'a, Result<(), BoxError>>;
}

impl<S: Store> DynStore for S {
    fn definitions(&self) -> bool {
        S::DEFINITIONS
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(Store::delete(self, key))
    }

    fn get<'a>(&'a self, keys: &'a [String]) -> BoxFuture<'a, Result<Map<String, Json>, BoxError>> {
        Box::pin(Store::get(self, keys))
    }

    fn keys(&self) -> BoxFuture<'_, Result<Option<Vec<String>>, BoxError>> {
        Box::pin(Store::keys(self))
    }

    fn set<'a>(&'a self, key: &'a str, value: &'a Json) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(Store::set(self, key, value))
    }

    fn delete_definition<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(Store::delete_definition(self, key))
    }

    fn list_definitions(&self) -> BoxFuture<'_, Result<Map<String, Json>, BoxError>> {
        Box::pin(Store::list_definitions(self))
    }

    fn set_definition<'a>(
        &'a self,
        key: &'a str,
        definition: &'a Definition,
    ) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(Store::set_definition(self, key, definition))
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unsupported() -> BoxError {
    "The store holds no definitions.".into()
}
