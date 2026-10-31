//! Runs the runtime behind a local HTTP server: resolution, overrides, access, and the admin API.
//! It asserts the results of `src/server/Vexla.test.ts`, so both runtimes behave the same way.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use reqwest::header::{COOKIE, SET_COOKIE};
use serde_json::{Map, json};
use vexla::definitions::{self, Definitions};
use vexla::overrides::{self, Signature};
use vexla::{Access, BoxError, Json, Key, MemoryStore, Runtime, Store, Values};

mod typed {
    vexla::flags!("tests/fixtures/runtime.env.flags");
}

use typed::{Flags, Pricing};

const SECRET: &str = "test-secret";

fn definitions() -> Definitions {
    definitions::parse_file(include_str!("fixtures/runtime.env.flags")).expect("valid definitions")
}

fn builder() -> vexla::Builder<Values> {
    Runtime::<Values>::builder()
        .definitions(definitions())
        .env([])
        .secret(SECRET)
}

fn now() -> i64 {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a time after the epoch");
    i64::try_from(elapsed.as_millis()).expect("milliseconds fit in i64")
}

/// Serves `router` on a random port of `127.0.0.1`, and returns its URL.
async fn listen(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port");
    let url = format!("http://{}", listener.local_addr().expect("an address"));
    tokio::spawn(async move { axum::serve(listener, router).await });
    url
}

/// Serves the runtime path through the layer, and `/app` with every value of the request.
async fn serve(runtime: &Runtime<Values>) -> String {
    let router = Router::new()
        .route(
            "/app",
            get(|flags: vexla::axum::Flags<Values>| async move {
                axum::Json(flags.evaluate().await.expect("values"))
            }),
        )
        .layer(runtime.layer());
    listen(router).await
}

async fn values(url: &str) -> Json {
    reqwest::get(url)
        .await
        .expect("a response")
        .json()
        .await
        .expect("JSON")
}

fn errors() -> (
    Arc<Mutex<Vec<String>>>,
    impl Fn(&vexla::Error) + Send + Sync + 'static,
) {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&errors);
    (errors, move |error: &vexla::Error| {
        sink.lock().expect("a lock").push(error.name().to_owned());
    })
}

mod evaluate {
    use super::*;

    #[tokio::test]
    async fn defaults() {
        let url = serve(&builder().build().expect("a runtime")).await;

        insta::assert_snapshot!(values(&format!("{url}/app")).await, @r#"{"BANNER":false,"LIMITS":{"requests":100},"NEW_CHECKOUT":false,"PRICING":"a","TITLE":"Hello"}"#);
    }

    #[tokio::test]
    async fn no_definitions_no_flags() {
        let runtime = Runtime::<Values>::builder()
            .env([("NEW_CHECKOUT".to_owned(), "true".to_owned())])
            .secret(SECRET)
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        insta::assert_snapshot!(values(&format!("{url}/app?flag.NEW_CHECKOUT=true")).await, @"{}");
    }

    #[tokio::test]
    async fn resolution_order() {
        let store = MemoryStore::with_values([("TITLE".to_owned(), json!("Stored"))]);
        let runtime = builder()
            .decide(Flags::PRICING, |plan: &String| {
                (plan == "enterprise").then_some(Pricing::C)
            })
            .env([
                ("LIMITS".to_owned(), r#"{"requests":5}"#.to_owned()),
                ("TITLE".to_owned(), "From env".to_owned()),
            ])
            .identify(|parts| {
                parts
                    .headers
                    .get("x-plan")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("free")
                    .to_owned()
            })
            .store(store)
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        let enterprise: Json = reqwest::Client::new()
            .get(format!("{url}/app?flag.NEW_CHECKOUT=true"))
            .header("x-plan", "enterprise")
            .send()
            .await
            .expect("a response")
            .json()
            .await
            .expect("JSON");
        insta::assert_snapshot!(enterprise["NEW_CHECKOUT"], @"true");
        insta::assert_snapshot!(enterprise["TITLE"], @r#""Stored""#);
        insta::assert_snapshot!(enterprise["PRICING"], @r#""c""#);
        insta::assert_snapshot!(enterprise["LIMITS"], @r#"{"requests":5}"#);

        let free = values(&format!("{url}/app")).await;
        insta::assert_snapshot!(free["PRICING"], @r#""a""#);
    }

    struct InvalidStore;

    impl Store for InvalidStore {
        async fn delete(&self, _: &str) -> Result<(), BoxError> {
            Ok(())
        }

        async fn get(&self, _: &[String]) -> Result<Map<String, Json>, BoxError> {
            Ok(Map::from_iter([("TITLE".to_owned(), json!(42))]))
        }

        async fn set(&self, _: &str, _: &Json) -> Result<(), BoxError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn invalid_store_value_and_decide_result_fall_through() {
        let (errors, on_error) = errors();
        // A key of another type than the flag lets `decide` return a value outside `options`.
        let pricing = Key::<String>::new("PRICING");
        let runtime = builder()
            .decide(pricing, |(): &()| Some("z".to_owned()))
            .on_error(on_error)
            .store(InvalidStore)
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        let values = values(&format!("{url}/app")).await;
        insta::assert_snapshot!(values["TITLE"], @r#""Hello""#);
        insta::assert_snapshot!(values["PRICING"], @r#""a""#);
        insta::assert_debug_snapshot!(errors.lock().expect("a lock"), @r#"
        [
            "Definitions.InvalidValueError",
            "Definitions.InvalidValueError",
        ]
        "#);
    }

    #[tokio::test]
    async fn get_runs_decide_once_for_one_flag_in_a_request() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let runtime = Runtime::<Flags>::builder()
            .decide(Flags::PRICING, move |(): &()| {
                counter.fetch_add(1, Ordering::SeqCst);
                Some(Pricing::B)
            })
            .decide(Flags::TITLE, |(): &()| None)
            .env([])
            .secret(SECRET)
            .build()
            .expect("a runtime");
        let router = Router::new()
            .route(
                "/app",
                get(|flags: vexla::axum::Flags<Flags>| async move {
                    let first = flags.get(Flags::PRICING).await.expect("a value");
                    let second = flags.get(Flags::PRICING).await.expect("a value");
                    format!("{} {}", first.as_str(), second.as_str())
                }),
            )
            .layer(runtime.layer());
        let url = listen(router).await;

        let body = reqwest::get(format!("{url}/app"))
            .await
            .expect("a response")
            .text()
            .await
            .expect("text");
        insta::assert_snapshot!(body, @"b b");
        insta::assert_snapshot!(calls.load(Ordering::SeqCst), @"1");
    }

    #[tokio::test]
    async fn typed_flags() {
        let runtime = Runtime::<Flags>::builder()
            .env([])
            .secret(SECRET)
            .build()
            .expect("a runtime");
        let parts = http::Request::get("https://app.example.com/?flag.NEW_CHECKOUT=true")
            .body(())
            .expect("a request")
            .into_parts()
            .0;

        let flags = runtime.evaluate(&parts).await.expect("flags");
        assert!(flags.new_checkout);
        assert_eq!(flags.pricing, Pricing::A);
        assert_eq!(flags.title, "Hello");
        assert!(
            runtime
                .get(&parts, Flags::NEW_CHECKOUT)
                .await
                .expect("a value")
        );
    }
}

mod overrides_ {
    use super::*;

    #[tokio::test]
    async fn production_public_flags_only_unless_signed() {
        let url = serve(&builder().build().expect("a runtime")).await;

        let unsigned = values(&format!(
            "{url}/app?flag.NEW_CHECKOUT=true&flag.PRICING=c&flag.BANNER=true"
        ))
        .await;
        insta::assert_snapshot!(json!([unsigned["NEW_CHECKOUT"], unsigned["PRICING"], unsigned["BANNER"]]), @r#"[true,"a",false]"#);

        let params = overrides::serialize(
            &Values::from_iter([("PRICING".to_owned(), json!("c"))]),
            Some(&Signature {
                expires_at: now() + 60_000,
                secret: SECRET,
            }),
        );
        let signed = values(&format!("{url}/app?{params}")).await;
        insta::assert_snapshot!(signed["PRICING"], @r#""c""#);

        let forged = params.replace("PRICING=c", "PRICING=b");
        let forged = values(&format!("{url}/app?{forged}")).await;
        insta::assert_snapshot!(forged["PRICING"], @r#""a""#);
    }

    #[tokio::test]
    async fn dev_mode_every_flag() {
        let url = serve(&builder().dev(true).build().expect("a runtime")).await;

        let values = values(&format!("{url}/app?flag.PRICING=c&flag.BANNER=true")).await;
        insta::assert_snapshot!(json!([values["PRICING"], values["BANNER"]]), @r#"["c",true]"#);
    }

    #[tokio::test]
    async fn the_layer_stores_search_parameter_overrides_in_the_cookie() {
        let url = serve(&builder().build().expect("a runtime")).await;

        let response = reqwest::get(format!("{url}/app?flag.NEW_CHECKOUT=true"))
            .await
            .expect("a response");
        let cookie = response.headers()[SET_COOKIE]
            .to_str()
            .expect("text")
            .to_owned();
        assert!(cookie.starts_with("vexla=flag.NEW_CHECKOUT%3Dtrue%26flag.exp%3D"));
        assert!(cookie.ends_with("; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure"));

        let pair = cookie.split(';').next().expect("a pair");
        let next: Json = reqwest::Client::new()
            .get(format!("{url}/app"))
            .header(COOKIE, pair)
            .send()
            .await
            .expect("a response")
            .json()
            .await
            .expect("JSON");
        insta::assert_snapshot!(next["NEW_CHECKOUT"], @"true");

        let plain = reqwest::get(format!("{url}/app"))
            .await
            .expect("a response");
        assert!(plain.headers().get(SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn a_forged_cookie_is_ignored() {
        let runtime = builder().build().expect("a runtime");
        let cookie = format!(
            "vexla={}",
            "flag.PRICING%3Dc%26flag.exp%3D9999999999%26flag.sig%3Dforged"
        );
        let parts = http::Request::get("https://app.example.com/")
            .header(COOKIE, cookie)
            .body(())
            .expect("a request")
            .into_parts()
            .0;

        let pricing = Key::<String>::new("PRICING");
        insta::assert_snapshot!(runtime.get(&parts, pricing).await.expect("a value"), @"a");
    }
}

mod fetch {
    use super::*;

    fn role_runtime() -> Runtime<Values> {
        builder()
            .authorize(|parts| {
                match parts
                    .headers
                    .get("x-role")
                    .and_then(|role| role.to_str().ok())
                {
                    Some("admin") => Access::Write,
                    Some("viewer") => Access::Read,
                    Some("challenge") => Access::Response(
                        http::Response::builder()
                            .status(401)
                            .header("www-authenticate", "Bearer")
                            .body("challenge".to_owned())
                            .expect("a response"),
                    ),
                    _ => Access::None,
                }
            })
            .store(MemoryStore::new())
            .build()
            .expect("a runtime")
    }

    #[tokio::test]
    async fn access() {
        let url = serve(&role_runtime()).await;
        let client = reqwest::Client::new();
        let status = |path: &str, role: Option<&str>, put: bool| {
            let mut request = if put {
                client
                    .put(format!("{url}/.flags{path}"))
                    .body(r#"{"value":true}"#)
            } else {
                client.get(format!("{url}/.flags{path}"))
            };
            request = request.header("content-type", "application/json");
            if let Some(role) = role {
                request = request.header("x-role", role);
            }
            async move { request.send().await.expect("a response") }
        };

        insta::assert_snapshot!(status("/manifest", None, false).await.status(), @"401 Unauthorized");
        insta::assert_snapshot!(status("/manifest", Some("viewer"), false).await.status(), @"200 OK");
        insta::assert_snapshot!(status("/values/NEW_CHECKOUT", Some("viewer"), true).await.status(), @"403 Forbidden");
        insta::assert_snapshot!(status("/values/NEW_CHECKOUT", Some("admin"), true).await.status(), @"200 OK");
        let challenge = status("/manifest", Some("challenge"), false).await;
        insta::assert_snapshot!(challenge.status(), @"401 Unauthorized");
        insta::assert_snapshot!(challenge.headers()["www-authenticate"].to_str().expect("text"), @"Bearer");
        insta::assert_snapshot!(status("/values", None, false).await.status(), @"200 OK");

        insta::assert_snapshot!(values(&format!("{url}/app")).await["NEW_CHECKOUT"], @"true");
    }

    #[tokio::test]
    async fn public_responses_never_hold_private_values() {
        let runtime = builder()
            .store(MemoryStore::with_values([(
                "PRICING".to_owned(),
                json!("c"),
            )]))
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        let values = values(&format!("{url}/.flags/values")).await;
        insta::assert_snapshot!(values, @r#"{"BANNER":false,"NEW_CHECKOUT":false,"TITLE":"Hello"}"#);

        let parts = http::Request::get("https://app.example.com/")
            .body(())
            .expect("a request")
            .into_parts()
            .0;
        insta::assert_snapshot!(runtime.script(&parts).await.expect("a script"), @r#"<script type="application/json" id="__vexla">{"BANNER":false,"NEW_CHECKOUT":false,"TITLE":"Hello"}</script>"#);
    }

    #[tokio::test]
    async fn script_escapes_a_value_that_would_close_the_element() {
        let runtime = builder()
            .store(MemoryStore::with_values([(
                "TITLE".to_owned(),
                json!("</script><script>alert(1)"),
            )]))
            .build()
            .expect("a runtime");
        let parts = http::Request::get("https://app.example.com/")
            .body(())
            .expect("a request")
            .into_parts()
            .0;

        let script = runtime.script(&parts).await.expect("a script");
        assert!(!script.contains("</script><script>"));
    }

    #[tokio::test]
    async fn store_values() {
        let url = serve(
            &builder()
                .dev(true)
                .store(MemoryStore::new())
                .build()
                .expect("a runtime"),
        )
        .await;
        let client = reqwest::Client::new();
        let put = |key: &str, value: Json| {
            client
                .put(format!("{url}/.flags/values/{key}"))
                .body(json!({ "value": value }).to_string())
                .send()
        };

        insta::assert_snapshot!(put("PRICING", json!("z")).await.expect("a response").status(), @"400 Bad Request");
        insta::assert_snapshot!(put("NOPE", json!(true)).await.expect("a response").status(), @"404 Not Found");
        insta::assert_snapshot!(put("PRICING", json!("b")).await.expect("a response").status(), @"200 OK");
        insta::assert_snapshot!(values(&format!("{url}/app")).await["PRICING"], @r#""b""#);

        client
            .delete(format!("{url}/.flags/values/PRICING"))
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(values(&format!("{url}/app")).await["PRICING"], @r#""a""#);
    }

    #[tokio::test]
    async fn orphan_values_are_listed_and_may_be_deleted() {
        let runtime = builder()
            .dev(true)
            .store(MemoryStore::with_values([
                ("oldFlag".to_owned(), json!(true)),
                ("TITLE".to_owned(), json!("Stored")),
            ]))
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        let manifest = values(&format!("{url}/.flags/manifest")).await;
        insta::assert_snapshot!(manifest["orphans"], @r#"["oldFlag"]"#);

        let deleted = reqwest::Client::new()
            .delete(format!("{url}/.flags/values/oldFlag"))
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(deleted.status(), @"200 OK");

        let manifest = values(&format!("{url}/.flags/manifest")).await;
        insta::assert_snapshot!(manifest["orphans"], @"[]");
    }

    #[tokio::test]
    async fn manifest() {
        let runtime = builder()
            .dev(true)
            .store(MemoryStore::with_values([(
                "TITLE".to_owned(),
                json!("Stored"),
            )]))
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;

        let manifest = values(&format!("{url}/.flags/manifest?flag.PRICING=b")).await;
        insta::assert_snapshot!(serde_json::to_string_pretty(&manifest["flags"]["TITLE"]).expect("JSON"), @r#"
        {
          "build": false,
          "default": "Hello",
          "override": null,
          "public": true,
          "source": "store",
          "stale": false,
          "store": "Stored",
          "type": "string",
          "value": "Stored"
        }
        "#);
        insta::assert_snapshot!(json!([manifest["flags"]["PRICING"]["source"], manifest["flags"]["PRICING"]["value"]]), @r#"["override","b"]"#);
        insta::assert_snapshot!(json!([manifest["store"], manifest["storeDefinitions"], manifest["version"]]), @"[true,false,1]");
    }

    #[tokio::test]
    async fn personal_overrides_set_a_cookie() {
        let url = serve(&builder().dev(true).build().expect("a runtime")).await;
        let client = reqwest::Client::new();

        let response = client
            .put(format!("{url}/.flags/overrides"))
            .body(r#"{"values":{"PRICING":"c"}}"#)
            .send()
            .await
            .expect("a response");
        let cookie = response.headers()[SET_COOKIE].to_str().expect("text");
        let pair = cookie.split(';').next().expect("a pair").to_owned();

        let values: Json = client
            .get(format!("{url}/app"))
            .header(COOKIE, pair)
            .send()
            .await
            .expect("a response")
            .json()
            .await
            .expect("JSON");
        insta::assert_snapshot!(values["PRICING"], @r#""c""#);

        let cleared = client
            .delete(format!("{url}/.flags/overrides"))
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(cleared.headers()[SET_COOKIE].to_str().expect("text"), @"vexla=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    }

    #[tokio::test]
    async fn links_override_a_private_flag_until_they_expire() {
        let runtime = builder()
            .authorize(|_| Access::Write)
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;
        let client = reqwest::Client::new();
        let link = |expires_at: i64| {
            client
                .post(format!("{url}/.flags/links"))
                .body(
                    json!({ "expiresAt": expires_at, "url": "/app", "values": { "PRICING": "c" } })
                        .to_string(),
                )
                .send()
        };

        let body: Json = link(now() + 60_000)
            .await
            .expect("a response")
            .json()
            .await
            .expect("JSON");
        let link_url = body["url"].as_str().expect("a URL");
        let query = link_url
            .strip_prefix(&format!("{url}/app?flag.PRICING=c&flag.exp="))
            .expect("the link of /app");
        let (exp, sig) = query.split_once("&flag.sig=").expect("a signature");
        assert!(exp.chars().all(|char| char.is_ascii_digit()));
        assert!(
            sig.chars()
                .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
        );
        insta::assert_snapshot!(values(link_url).await["PRICING"], @r#""c""#);

        let expired: Json = link(now() - 1_000)
            .await
            .expect("a response")
            .json()
            .await
            .expect("JSON");
        let expired = expired["url"].as_str().expect("a URL");
        insta::assert_snapshot!(values(expired).await["PRICING"], @r#""a""#);

        let build = client
            .post(format!("{url}/.flags/links"))
            .body(r#"{"expiresAt":0,"url":"/app","values":{"BANNER":true}}"#)
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(build.status(), @"400 Bad Request");
        insta::assert_snapshot!(build.text().await.expect("text"), @r#"{"error":"build_flag","key":"BANNER"}"#);
    }

    #[tokio::test]
    async fn store_definitions_and_409_with_a_flags_file() {
        // A runtime with no authorize has no access outside dev mode.
        let closed = Runtime::<Values>::builder()
            .env([])
            .secret(SECRET)
            .store(MemoryStore::new())
            .build()
            .expect("a runtime");
        let url = serve(&closed).await;
        let client = reqwest::Client::new();
        let status = client
            .put(format!("{url}/.flags/definitions/BETA"))
            .body("{}")
            .send()
            .await
            .expect("a response")
            .status();
        insta::assert_snapshot!(status, @"401 Unauthorized");

        let open = Runtime::<Values>::builder()
            .dev(true)
            .env([])
            .store(MemoryStore::new())
            .build()
            .expect("a runtime");
        let url = serve(&open).await;
        let created = client
            .put(format!("{url}/.flags/definitions/BETA"))
            .body(r#"{"default":false,"public":true,"type":"boolean"}"#)
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(created.status(), @"200 OK");
        insta::assert_snapshot!(values(&format!("{url}/app?flag.BETA=true")).await, @r#"{"BETA":true}"#);

        let invalid = client
            .put(format!("{url}/.flags/definitions/GAMMA"))
            .body(r#"{"default":1,"type":"boolean"}"#)
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(invalid.status(), @"400 Bad Request");

        let deleted = client
            .delete(format!("{url}/.flags/definitions/BETA"))
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(deleted.status(), @"200 OK");
        insta::assert_snapshot!(values(&format!("{url}/app")).await, @"{}");

        let with_file = serve(
            &builder()
                .dev(true)
                .store(MemoryStore::new())
                .build()
                .expect("a runtime"),
        )
        .await;
        let conflict = client
            .put(format!("{with_file}/.flags/definitions/BETA"))
            .body("{}")
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(conflict.status(), @"409 Conflict");
    }

    struct DownStore;

    impl Store for DownStore {
        const DEFINITIONS: bool = true;

        async fn delete(&self, _: &str) -> Result<(), BoxError> {
            Ok(())
        }

        async fn get(&self, _: &[String]) -> Result<Map<String, Json>, BoxError> {
            Ok(Map::new())
        }

        async fn set(&self, _: &str, _: &Json) -> Result<(), BoxError> {
            Ok(())
        }

        async fn list_definitions(&self) -> Result<Map<String, Json>, BoxError> {
            Err("database down".into())
        }
    }

    #[tokio::test]
    async fn store_definitions_unavailable() {
        let runtime = Runtime::<Values>::builder()
            .dev(true)
            .env([])
            .store(DownStore)
            .build()
            .expect("a runtime");
        let parts = http::Request::get("https://app.example.com/")
            .body(())
            .expect("a request")
            .into_parts()
            .0;

        let error = runtime
            .get(&parts, Key::<bool>::new("BETA"))
            .await
            .expect_err("no definitions");
        insta::assert_snapshot!(error.name(), @"Runtime.DefinitionsUnavailableError");

        let url = serve(&runtime).await;
        let status = reqwest::get(format!("{url}/.flags/manifest"))
            .await
            .expect("a response")
            .status();
        insta::assert_snapshot!(status, @"503 Service Unavailable");
    }

    #[tokio::test]
    async fn cors_on_the_values_endpoint_only() {
        let runtime = builder()
            .cors(["https://web.example.com"])
            .build()
            .expect("a runtime");
        let url = serve(&runtime).await;
        let client = reqwest::Client::new();
        let origin = |path: &str, origin: &str| {
            client
                .get(format!("{url}/.flags{path}"))
                .header("origin", origin)
                .send()
        };

        let allowed = origin("/values", "https://web.example.com")
            .await
            .expect("a response");
        insta::assert_snapshot!(allowed.headers()["access-control-allow-origin"].to_str().expect("text"), @"https://web.example.com");

        let other = origin("/values", "https://evil.example.com")
            .await
            .expect("a response");
        assert!(other.headers().get("access-control-allow-origin").is_none());

        let admin = origin("/manifest", "https://web.example.com")
            .await
            .expect("a response");
        assert!(admin.headers().get("access-control-allow-origin").is_none());

        let preflight = client
            .request(reqwest::Method::OPTIONS, format!("{url}/.flags/values"))
            .header("origin", "https://web.example.com")
            .send()
            .await
            .expect("a response");
        insta::assert_snapshot!(preflight.status(), @"204 No Content");
    }

    #[tokio::test]
    async fn dev_route_page() {
        let url = serve(&builder().dev(true).build().expect("a runtime")).await;

        let response = reqwest::get(format!("{url}/.flags"))
            .await
            .expect("a response");
        insta::assert_snapshot!(response.headers()["content-type"].to_str().expect("text"), @"text/html; charset=utf-8");
        let html = response.text().await.expect("text");
        assert!(html.contains("<title>Flags</title>"));
        assert!(html.contains(r#"<script type="application/json" id="config">{"path":"/.flags","write":true}</script>"#));
    }

    #[tokio::test]
    async fn the_service_returns_404_outside_the_path() {
        let runtime = builder().dev(true).build().expect("a runtime");
        let url = listen(Router::new().fallback_service(runtime.service())).await;

        let outside = reqwest::get(format!("{url}/other"))
            .await
            .expect("a response");
        insta::assert_snapshot!(outside.status(), @"404 Not Found");
        let values = reqwest::get(format!("{url}/.flags/values"))
            .await
            .expect("a response");
        insta::assert_snapshot!(values.status(), @"200 OK");
    }

    #[tokio::test]
    async fn the_service_under_nest_service() {
        let runtime = builder().dev(true).build().expect("a runtime");
        let url = listen(Router::new().nest_service("/.flags", runtime.service())).await;

        let manifest = values(&format!("{url}/.flags/manifest")).await;
        insta::assert_snapshot!(manifest["version"], @"1");
    }
}

mod build {
    use super::*;

    #[tokio::test]
    async fn needs_a_secret_outside_dev_mode() {
        let error = Runtime::<Values>::builder()
            .definitions(definitions())
            .build()
            .expect_err("no secret");
        insta::assert_snapshot!(error, @"`Runtime::builder` needs `secret` outside dev mode. Set `secret`, such as from `VEXLA_SECRET`.");
    }

    #[tokio::test]
    async fn pull_emits_build_flag_variables() {
        let store = MemoryStore::with_values([("BANNER".to_owned(), json!(true))]);
        let runtime = builder()
            .authorize(|parts| {
                if parts
                    .headers
                    .get("authorization")
                    .is_some_and(|value| value == "Bearer ci")
                {
                    Access::Read
                } else {
                    Access::None
                }
            })
            .store(store)
            .build()
            .expect("a runtime");
        let url = format!("{}/.flags", serve(&runtime).await);

        let lines = tokio::task::spawn_blocking(move || {
            let env = std::collections::BTreeMap::new();
            let options = vexla::build::Options {
                env: &env,
                token: Some("ci"),
            };
            let lines = vexla::build::instructions(&url, &options).expect("instructions");
            let denied = vexla::build::instructions(
                &url,
                &vexla::build::Options {
                    env: &env,
                    token: None,
                },
            )
            .expect_err("no access");
            (lines, denied.to_string())
        })
        .await
        .expect("a blocking task");

        insta::assert_debug_snapshot!(lines.0, @r#"
        [
            "cargo:rustc-env=BANNER=true",
            "cargo:rerun-if-env-changed=VEXLA_TOKEN",
            "cargo:rerun-if-env-changed=BANNER",
        ]
        "#);
        insta::assert_snapshot!(lines.1, @r"
        The remote admin API returned 401 for GET /manifest.

        To resolve: Set `token` to a token that the remote `authorize` accepts with the access the store needs.
        ");
    }
}
