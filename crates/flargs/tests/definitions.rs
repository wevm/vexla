//! Runs `test/vectors/definitions.json` against `flargs::definitions`, and parses the same flags
//! from TOML.

use std::collections::BTreeMap;

use flargs::Json;
use flargs::definitions::{self, Definition, ENV_PREFIX, Type};

fn vectors() -> Json {
    let text = include_str!("../../../test/vectors/definitions.json");
    serde_json::from_str(text).expect("the vectors are JSON")
}

fn env(value: &Json) -> BTreeMap<String, String> {
    serde_json::from_value(value.clone()).expect("an env vector is an object of strings")
}

fn str(value: &Json) -> &str {
    value.as_str().expect("a string")
}

#[test]
fn env_of() {
    for case in vectors()["envOf"].as_array().expect("envOf") {
        assert_eq!(
            definitions::env_of(str(&case[0]), ENV_PREFIX),
            str(&case[1]),
            "{case}"
        );
    }
}

#[test]
fn key_of() {
    for case in vectors()["keyOf"].as_array().expect("keyOf") {
        assert_eq!(
            definitions::key_of(str(&case[0]), ENV_PREFIX),
            str(&case[1]),
            "{case}"
        );
    }
}

mod parse {
    use super::*;

    #[test]
    fn vectors() {
        for case in super::vectors()["parse"].as_array().expect("parse") {
            let name = str(&case["name"]);
            let result = definitions::parse(&case["input"], ENV_PREFIX);

            if let Some(key) = case.get("error") {
                assert_eq!(result.expect_err(name).key, str(key), "{name}");
            } else {
                let output = serde_json::to_value(result.expect(name)).expect("serializes");
                assert_eq!(output, case["output"], "{name}");
            }
        }
    }

    #[test]
    fn toml() {
        let text = r#"
            [limits]
            default = { requests = 100 }
            type = "json"

            [maintenance_banner]
            build = true
            default = false
            public = true
            type = "boolean"

            [new_checkout]
            default = false
            description = "Use the new checkout flow."
            public = true
            type = "boolean"

            [pricing]
            default = "a"
            options = ["a", "b", "c"]
            type = "select"

            [retries]
            default = 3
            type = "number"

            [title]
            default = "Hello"
            env = "APP_TITLE"
            expires = "2027-01-31"
            type = "string"
        "#;
        let expected = &super::vectors()["parse"][0]["output"];

        let output = definitions::parse_toml(text, ENV_PREFIX).expect("valid TOML");

        assert_eq!(&serde_json::to_value(output).expect("serializes"), expected);
    }

    #[test]
    fn toml_errors() {
        let error = definitions::parse_toml("[new_checkout]\ntype = \"boolean\"\n", ENV_PREFIX)
            .expect_err("no default");
        insta::assert_snapshot!(error, @r"
        The declaration of newCheckout needs a `default`.

        To resolve: Fix the declaration of newCheckout in the flags file, as the JSON Schema describes.
        ");

        let error = definitions::parse_toml(
            "[new_checkout]\ndefault = false\nexpires = 2027-01-31\ntype = \"boolean\"\n",
            ENV_PREFIX,
        )
        .expect_err("a TOML date");
        assert_eq!(error.key, "newCheckout");

        let error = definitions::parse_toml("[new_checkout", ENV_PREFIX).expect_err("not TOML");
        assert_eq!(error.key, "(root)");
    }

    #[test]
    fn env_prefix() {
        let input = serde_json::json!({ "newCheckout": { "default": false, "type": "boolean" } });

        let output = definitions::parse(&input, "APP_").expect("valid");

        assert_eq!(output["newCheckout"].env, "APP_NEW_CHECKOUT");
    }
}

#[test]
fn from_env() {
    for case in vectors()["fromEnv"].as_array().expect("fromEnv") {
        let output = definitions::from_env(&env(&case["env"]), ENV_PREFIX);

        assert_eq!(
            serde_json::to_value(output).expect("serializes"),
            case["output"],
            "{}",
            str(&case["name"])
        );
    }
}

#[test]
fn check() {
    for case in vectors()["check"].as_array().expect("check") {
        let definitions =
            definitions::parse(&case["definitions"], ENV_PREFIX).expect("valid definitions");
        let now = case["now"].as_i64().expect("now");

        let issues = definitions::check(&definitions, &env(&case["env"]), ENV_PREFIX, now);

        assert_eq!(
            serde_json::to_value(issues).expect("serializes"),
            case["issues"],
            "{}",
            str(&case["name"])
        );
    }
}

mod decode {
    use super::*;

    fn definition(case: &Json) -> Definition {
        let r#type = match str(&case["type"]) {
            "boolean" => Type::Boolean,
            "json" => Type::Json,
            "number" => Type::Number,
            "select" => Type::Select,
            _ => Type::String,
        };
        let options = case
            .get("options")
            .map(|options| serde_json::from_value(options.clone()).expect("options"));

        Definition {
            build: false,
            default: Json::Null,
            description: None,
            env: "FEATURE_FLAG".to_owned(),
            expires: None,
            options,
            public: false,
            r#type,
        }
    }

    #[test]
    fn vectors() {
        for case in super::vectors()["decode"].as_array().expect("decode") {
            let result = definitions::decode(&definition(case), str(&case["raw"]), "flag");

            match case.get("value") {
                Some(value) => assert_eq!(&result.expect("a value"), value, "{case}"),
                None => assert_eq!(result.expect_err("an error").key, "flag", "{case}"),
            }
        }
    }

    #[test]
    fn error() {
        let definition = definition(&serde_json::json!({ "type": "number" }));

        let error = definitions::decode(&definition, "two", "retries").expect_err("not a number");

        insta::assert_snapshot!(error, @r"
        The value for retries (FEATURE_FLAG) is not a number value of the flag.

        To resolve: Set FEATURE_FLAG to a value of the flag, as its declaration in the flags file describes.
        ");
    }

    #[test]
    fn numbers() {
        let definition = definition(&serde_json::json!({ "type": "number" }));
        let decode = |raw: &str| definitions::decode(&definition, raw, "flag").ok();

        assert_eq!(decode(" 3 "), Some(serde_json::json!(3)));
        assert_eq!(decode("0x10"), Some(serde_json::json!(16)));
        assert_eq!(decode("1e3"), Some(serde_json::json!(1000)));
        assert_eq!(decode(".5"), Some(serde_json::json!(0.5)));
        assert_eq!(decode("Infinity"), None);
        assert_eq!(decode("1e400"), None);
        assert_eq!(decode("NaN"), None);
        assert_eq!(decode("inf"), None);
    }
}

#[test]
fn values() {
    let definitions = definitions::parse(
        &serde_json::json!({
            "newCheckout": { "default": false, "type": "boolean" },
            "pricing": { "default": "a", "options": ["a", "b"], "type": "select" },
        }),
        ENV_PREFIX,
    )
    .expect("valid");

    let values = definitions::values(
        &definitions,
        &env(&serde_json::json!({ "FEATURE_PRICING": "b", "FEATURE_UNKNOWN": "x" })),
    )
    .expect("valid values");
    assert_eq!(
        serde_json::to_value(values).expect("serializes"),
        serde_json::json!({ "pricing": "b" })
    );

    let error = definitions::values(
        &definitions,
        &env(&serde_json::json!({ "FEATURE_PRICING": "z" })),
    )
    .expect_err("not an option");
    assert_eq!(error.key, "pricing");
}
