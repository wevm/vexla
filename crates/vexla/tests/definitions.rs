//! Runs `test/vectors/definitions.json` and `test/vectors/file.json` against
//! `vexla::definitions`.

use std::collections::BTreeMap;

use vexla::Json;
use vexla::definitions::{self, Definition, Type};

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

mod parse {
    use super::*;

    #[test]
    fn vectors() {
        for case in super::vectors()["parse"].as_array().expect("parse") {
            let name = str(&case["name"]);
            let result = definitions::parse(&case["input"]);

            if let Some(key) = case.get("error") {
                assert_eq!(result.expect_err(name).key, str(key), "{name}");
            } else {
                let output = serde_json::to_value(result.expect(name)).expect("serializes");
                assert_eq!(output, case["output"], "{name}");
            }
        }
    }

    #[test]
    fn errors() {
        let error = definitions::parse(&serde_json::json!({ "new-checkout": {} }))
            .expect_err("not a variable name");
        insta::assert_snapshot!(error, @r"
        The key new-checkout is not an environment variable name, such as NEW_CHECKOUT.

        To resolve: Fix the declaration of new-checkout in `.env.flags`, or in the store definition.
        ");

        let error = definitions::parse(&serde_json::json!([])).expect_err("not an object");
        insta::assert_snapshot!(error, @r"
        The definitions are not an object.

        To resolve: Fix the declaration of (root) in `.env.flags`, or in the store definition.
        ");
    }
}

mod parse_file {
    use super::*;

    #[test]
    fn vectors() {
        let text = include_str!("../../../test/vectors/file.json");
        let vectors: Json = serde_json::from_str(text).expect("the vectors are JSON");

        for case in vectors["parseFile"].as_array().expect("parseFile") {
            let name = str(&case["name"]);
            let result = definitions::parse_file(str(&case["text"]));

            if let Some(key) = case.get("error") {
                assert_eq!(result.expect_err(name).key, str(key), "{name}");
            } else {
                let output = serde_json::to_value(result.expect(name)).expect("serializes");
                assert_eq!(output, case["output"], "{name}");
            }
        }
    }

    #[test]
    fn errors() {
        let error =
            definitions::parse_file("# @type {number}\nRETRIES=three\n").expect_err("not a number");
        insta::assert_snapshot!(error, @r"
        The default of RETRIES is not a number value (line 2).

        To resolve: Fix the declaration of RETRIES in `.env.flags`, or in the store definition.
        ");

        let error = definitions::parse_file("# @type {boolean}\nBETA false\n")
            .expect_err("not a NAME=value line");
        insta::assert_snapshot!(error, @r"
        Line 2 is not a comment or a NAME=value line.

        To resolve: Fix the declaration of line 2 in `.env.flags`, or in the store definition.
        ");
    }

    #[test]
    fn lines() {
        let text = "\u{feff}# Beta.\r\n# @type {string}\r\nexport BETA = \"a\\nb\"\r\n";

        let output = definitions::parse_file(text).expect("valid");

        assert_eq!(output["BETA"].description.as_deref(), Some("Beta."));
        assert_eq!(output["BETA"].default, serde_json::json!("a\nb"));
    }
}

#[test]
fn infer() {
    for case in vectors()["infer"].as_array().expect("infer") {
        assert_eq!(
            definitions::infer(str(&case["raw"])),
            case["value"],
            "{case}"
        );
    }
}

#[test]
fn check() {
    for case in vectors()["check"].as_array().expect("check") {
        let definitions = definitions::parse(&case["definitions"]).expect("valid definitions");
        let now = case["now"].as_i64().expect("now");
        let prefix = case.get("prefix").map(str);

        let issues = definitions::check(&definitions, &env(&case["env"]), prefix, now);

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

        let error = definitions::decode(&definition, "two", "RETRIES").expect_err("not a number");

        insta::assert_snapshot!(error, @r"
        The value of RETRIES is not a number value of the flag.

        To resolve: Set RETRIES to a value of the flag, as its declaration in `.env.flags` describes.
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
    let definitions = definitions::parse(&serde_json::json!({
        "NEW_CHECKOUT": { "default": false, "type": "boolean" },
        "PRICING": { "default": "a", "options": ["a", "b"], "type": "select" },
    }))
    .expect("valid");

    let values = definitions::values(
        &definitions,
        &env(&serde_json::json!({ "PRICING": "b", "UNKNOWN": "x" })),
    )
    .expect("valid values");
    assert_eq!(
        serde_json::to_value(values).expect("serializes"),
        serde_json::json!({ "PRICING": "b" })
    );

    let error = definitions::values(&definitions, &env(&serde_json::json!({ "PRICING": "z" })))
        .expect_err("not an option");
    assert_eq!(error.key, "PRICING");
}
