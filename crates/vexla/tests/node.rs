//! Runs `HttpStore`, `Client`, and `build::instructions` against the TypeScript runtime of the
//! built package, and a Rust runtime against the TypeScript runtime as its store.
//!
//! The tests need Node and the built package, so they are ignored by default. Run them with:
//!
//! ```sh
//! pnpm install && pnpm build
//! cargo test -p vexla --test node -- --ignored
//! ```

use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use vexla::client::{Client, HttpStore};
use vexla::overrides::{self, Signature};
use vexla::{Json, Key, Runtime, Store, Values};

/// The URLs of the TypeScript runtimes: one with a flags file, and one with store definitions.
struct Remote {
    _child: Child,
    file: String,
    store: String,
}

async fn remote() -> Remote {
    let mut child = Command::new("node")
        .arg("tests/fixtures/server.ts")
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .spawn()
        .expect("node starts");
    let stdout = child.stdout.take().expect("a stdout pipe");
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        BufReader::new(stdout).read_line(&mut line),
    )
    .await
    .expect("the server starts within 10 seconds")
    .expect("a line");

    let urls: Json = serde_json::from_str(&line).expect("the URLs as JSON");
    Remote {
        _child: child,
        file: urls["file"].as_str().expect("a URL").to_owned(),
        store: urls["store"].as_str().expect("a URL").to_owned(),
    }
}

fn parts(url: &str) -> http::request::Parts {
    http::Request::get(url)
        .body(())
        .expect("a request")
        .into_parts()
        .0
}

mod http_store {
    use super::*;

    #[tokio::test]
    #[ignore = "needs Node and `pnpm build`"]
    async fn a_value_set_on_the_typescript_runtime_applies_to_the_rust_runtime() {
        let remote = remote().await;
        let store = HttpStore::new(&remote.file)
            .token("admin")
            .ttl(Duration::ZERO);
        let local = Runtime::<Values>::builder()
            .env([])
            .secret("local-secret")
            .store(
                HttpStore::new(&remote.file)
                    .token("admin")
                    .ttl(Duration::ZERO),
            )
            .build()
            .expect("a runtime");
        let new_checkout = Key::<bool>::new("NEW_CHECKOUT");
        let read = || async {
            local
                .get(&parts("https://app.example.com/"), new_checkout)
                .await
                .expect("a value")
        };

        // The local runtime has no flags file, so it reads the definitions of the remote runtime.
        insta::assert_snapshot!(read().await, @"false");
        store
            .set("NEW_CHECKOUT", &json!(true))
            .await
            .expect("a write");
        insta::assert_snapshot!(read().await, @"true");

        let stored = store
            .get(&["NEW_CHECKOUT".to_owned(), "PRICING".to_owned()])
            .await
            .expect("values");
        insta::assert_snapshot!(Json::Object(stored), @r#"{"NEW_CHECKOUT":true}"#);
        insta::assert_debug_snapshot!(store.keys().await.expect("keys"), @r#"
        Some(
            [
                "NEW_CHECKOUT",
            ],
        )
        "#);

        store.delete("NEW_CHECKOUT").await.expect("a delete");
        insta::assert_snapshot!(read().await, @"false");
    }

    #[tokio::test]
    #[ignore = "needs Node and `pnpm build`"]
    async fn store_definitions_through_the_typescript_runtime() {
        let remote = remote().await;
        let store = HttpStore::new(&remote.store)
            .token("admin")
            .ttl(Duration::ZERO);
        let definition =
            vexla::definitions::parse(&json!({ "BETA": { "default": true, "type": "boolean" } }))
                .expect("a definition")
                .remove("BETA")
                .expect("BETA");
        store
            .set_definition("BETA", &definition)
            .await
            .expect("a definition write");

        let local = Runtime::<Values>::builder()
            .env([])
            .secret("local-secret")
            .store(store)
            .build()
            .expect("a runtime");
        let beta = Key::<bool>::new("BETA");
        insta::assert_snapshot!(local.get(&parts("https://app.example.com/"), beta).await.expect("a value"), @"true");
    }

    #[tokio::test]
    #[ignore = "needs Node and `pnpm build`"]
    async fn an_error_status_holds_no_token() {
        let remote = remote().await;
        let store = HttpStore::new(&remote.file).token("wrong-token");

        let error = store
            .get(&["NEW_CHECKOUT".to_owned()])
            .await
            .expect_err("no access");
        let message = error.to_string();
        assert!(!message.contains("wrong-token"));
        insta::assert_snapshot!(message, @r"
        The remote admin API returned 401 for GET /manifest.

        To resolve: Set `token` to a token that the remote `authorize` accepts with the access the store needs.
        ");
    }
}

mod client {
    use super::*;

    #[tokio::test]
    #[ignore = "needs Node and `pnpm build`"]
    async fn values_hold_public_flags_and_accept_signed_overrides() {
        let remote = remote().await;
        let client = Client::new(&remote.file);

        insta::assert_snapshot!(json!(client.values("").await.expect("values")), @r#"{"BANNER":false,"NEW_CHECKOUT":false}"#);
        insta::assert_snapshot!(json!(client.values("flag.NEW_CHECKOUT=true").await.expect("values")), @r#"{"BANNER":false,"NEW_CHECKOUT":true}"#);

        // The signature of the Rust crate verifies in the TypeScript runtime.
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a time after the epoch")
            .as_millis();
        let params = overrides::serialize(
            &Values::from_iter([("NEW_CHECKOUT".to_owned(), json!(true))]),
            Some(&Signature {
                expires_at: i64::try_from(expires_at).expect("fits in i64") + 60_000,
                secret: "remote-secret",
            }),
        );
        insta::assert_snapshot!(json!(client.values(&params).await.expect("values")), @r#"{"BANNER":false,"NEW_CHECKOUT":true}"#);

        // A signature that does not match drops every override, even of a public flag.
        let forged = params.replace("flag.sig=", "flag.sig=forged");
        insta::assert_snapshot!(json!(client.values(&forged).await.expect("values")), @r#"{"BANNER":false,"NEW_CHECKOUT":false}"#);
    }

    #[tokio::test]
    #[ignore = "needs Node and `pnpm build`"]
    async fn build_instructions_from_the_typescript_manifest() {
        let remote = remote().await;
        HttpStore::new(&remote.file)
            .token("admin")
            .set("BANNER", &json!(true))
            .await
            .expect("a write");

        let url = remote.file.clone();
        let lines = tokio::task::spawn_blocking(move || {
            let env = std::collections::BTreeMap::new();
            vexla::build::instructions(
                &url,
                &vexla::build::Options {
                    env: &env,
                    token: Some("admin"),
                },
            )
            .expect("instructions")
        })
        .await
        .expect("a blocking task");
        insta::assert_debug_snapshot!(lines, @r#"
        [
            "cargo:rustc-env=BANNER=true",
            "cargo:rerun-if-env-changed=VEXLA_TOKEN",
            "cargo:rerun-if-env-changed=BANNER",
        ]
        "#);
    }
}
