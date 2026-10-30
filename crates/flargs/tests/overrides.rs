//! Runs `test/vectors/overrides.json` against `flargs::overrides`.

use std::collections::BTreeMap;

use flargs::Json;
use flargs::definitions::{self, Definitions};
use flargs::overrides::{self, ParseOptions, Signature};

fn vectors() -> Json {
    let text = include_str!("../../../test/vectors/overrides.json");
    serde_json::from_str(text).expect("the vectors are JSON")
}

fn definitions(vectors: &Json) -> Definitions {
    definitions::parse(&vectors["definitions"]).expect("valid definitions")
}

fn str(value: &Json) -> &str {
    value.as_str().expect("a string")
}

mod parse {
    use super::*;

    #[test]
    fn vectors() {
        let vectors = super::vectors();
        let definitions = definitions(&vectors);

        for case in vectors["cases"].as_array().expect("cases") {
            let name = str(&case["name"]);
            let secret = case.get("secret").unwrap_or(&vectors["secret"]).as_str();
            let options = ParseOptions {
                definitions: &definitions,
                dev: case["dev"].as_bool().unwrap_or(false),
                now: case
                    .get("now")
                    .unwrap_or(&vectors["now"])
                    .as_i64()
                    .expect("now"),
                secret,
            };

            let result = overrides::parse(str(&case["query"]), &options);

            if let Some(reason) = case.get("throws") {
                assert_eq!(result.expect_err(name).reason(), str(reason), "{name}");
                continue;
            }

            let overrides = result.expect(name);
            let errors: Vec<&str> = overrides
                .errors
                .iter()
                .map(overrides::Error::name)
                .collect();
            let expected: Vec<&str> = case["errors"]
                .as_array()
                .expect("errors")
                .iter()
                .map(str)
                .collect();
            assert_eq!(errors, expected, "{name}");
            assert_eq!(
                serde_json::to_value(&overrides.values).expect("serializes"),
                case["values"],
                "{name}"
            );
            assert_eq!(
                overrides.reset,
                case["reset"].as_bool().unwrap_or(false),
                "{name}"
            );
            assert_eq!(
                overrides.signed,
                case["signed"].as_bool().unwrap_or(false),
                "{name}"
            );
            assert_eq!(overrides.expires_at.is_some(), overrides.signed, "{name}");
        }
    }

    #[test]
    fn errors() {
        let vectors = super::vectors();
        let definitions = definitions(&vectors);
        let options = ParseOptions {
            definitions: &definitions,
            dev: false,
            now: 0,
            secret: None,
        };

        let overrides = overrides::parse("?flag.BANNER=true&flag.PRICING=c&flag.NOPE=1", &options)
            .expect("unsigned");

        let [build, private, unknown] = overrides.errors.as_slice() else {
            panic!("three errors");
        };
        insta::assert_snapshot!(build, @r"
        The build flag BANNER accepts no override outside dev mode.

        To resolve: Set the variable of the flag for the build, or override it in dev mode.
        ");
        insta::assert_snapshot!(private, @r"
        The private flag PRICING accepts only a signed override outside dev mode.

        To resolve: Request a signed link with `flargs link`, or `POST /.flags/links`.
        ");
        insta::assert_snapshot!(unknown, @r"
        No flag declares the key NOPE.

        To resolve: Check the key against the flags file.
        ");

        let error =
            overrides::parse("flag.PRICING=c&flag.sig=abc", &options).expect_err("no secret");
        insta::assert_snapshot!(error, @r"
        The override is signed, but the runtime has no secret to verify it.

        To resolve: Set `secret` on the runtime, such as from `FLARGS_SECRET`.
        ");
    }
}

#[test]
fn serialize() {
    let vectors = vectors();
    let secret = str(&vectors["secret"]);

    for case in vectors["serialize"].as_array().expect("serialize") {
        let name = str(&case["name"]);
        let values: BTreeMap<String, Json> =
            serde_json::from_value(case["values"].clone()).expect("values");
        let signature = case["expiresAt"]
            .as_i64()
            .map(|expires_at| Signature { expires_at, secret });

        let query = overrides::serialize(&values, signature.as_ref());

        assert_eq!(query, str(&case["query"]), "{name}");
    }
}

#[test]
fn round_trip() {
    let vectors = vectors();
    let definitions = definitions(&vectors);
    let values: BTreeMap<String, Json> = serde_json::from_value(serde_json::json!({
        "LIMITS": { "requests": 5 },
        "PRICING": "b",
    }))
    .expect("values");
    let signature = Signature {
        expires_at: 1_767_225_600_000,
        secret: "test-secret",
    };
    let options = ParseOptions {
        definitions: &definitions,
        dev: false,
        now: 1_767_225_000_000,
        secret: Some("test-secret"),
    };

    let query = overrides::serialize(&values, Some(&signature));
    let overrides = overrides::parse(&query, &options).expect("a valid signature");

    assert!(overrides.errors.is_empty());
    assert_eq!(overrides.expires_at, Some(1_767_225_600_000));
    assert!(overrides.signed);
    assert_eq!(overrides.values, values);
}
