//! Flag definitions: the `.env.flags` file, validation of definition objects (the store and the
//! admin API), inference from `FEATURE_*` variables, the mapping between keys and environment
//! variables, and the decoding of variable values.
//!
//! The `flargs` crate re-exports this crate as `flargs::definitions`. The `flargs::flags!` macro
//! parses `.env.flags` with the same functions at compile time, so the shared vectors cover both.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

/// A JSON value.
pub type Json = Value;

/// Every flag of a project, keyed by flag key.
pub type Definitions = BTreeMap<String, Definition>;

/// The default prefix of flag environment variables.
pub const ENV_PREFIX: &str = "FEATURE_";

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

const MS_PER_DAY: i64 = 86_400_000;

/// One flag, as a flags file declares it after validation. It serializes to the manifest shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Definition {
    /// `true` for a build flag, which resolves when the bundle builds.
    pub build: bool,
    /// The value when no other source has one.
    pub default: Json,
    /// The description, for the dev route, the admin API, and `.env.example`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The environment variable that sets the value.
    pub env: String,
    /// The date (`YYYY-MM-DD`) after which the flag is due for retirement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    /// The values of a select flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// `true` when the value may reach a browser.
    pub public: bool,
    /// The type of the value.
    pub r#type: Type,
}

/// A problem that [`check`] found in an environment.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Issue {
    /// The environment variable.
    pub env: String,
    /// The key of the flag, when a flag declares the variable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Why the variable is a problem.
    pub reason: Reason,
}

/// Why [`check`] reports a variable.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// The value is not a value of the flag.
    Invalid,
    /// The flag is past its `expires` date.
    Stale,
    /// No flag declares the variable.
    Unknown,
}

/// The type of a flag.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Type {
    /// `true` or `false`.
    Boolean,
    /// Any JSON value.
    Json,
    /// A finite number.
    Number,
    /// One of the `options` of the flag.
    Select,
    /// Any string.
    String,
}

impl Type {
    /// Returns the name of the type, as a flags file writes it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Boolean => "boolean",
            Self::Json => "json",
            Self::Number => "number",
            Self::Select => "select",
            Self::String => "string",
        }
    }

    fn of(name: &str) -> Option<Self> {
        match name {
            "boolean" => Some(Self::Boolean),
            "json" => Some(Self::Json),
            "number" => Some(Self::Number),
            "select" => Some(Self::Select),
            "string" => Some(Self::String),
            _ => None,
        }
    }
}

impl fmt::Display for Type {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Returned when a declaration in a flags file does not follow the schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidDeclarationError {
    /// The key of the flag, the variable name when it lacks the prefix, `line N` for a line that is
    /// not a comment or a `NAME=value` line, or `(root)` when the input is not an object.
    pub key: String,
    /// What failed.
    pub reason: String,
}

impl fmt::Display for InvalidDeclarationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}\n\nTo resolve: Fix the declaration of {} in `.env.flags`, or in the store definition.",
            self.reason, self.key
        )
    }
}

impl std::error::Error for InvalidDeclarationError {}

/// Returned when an environment variable or an override holds a value that is not a value of its
/// flag. The error never holds the value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidValueError {
    /// The environment variable.
    pub env: String,
    /// The key of the flag.
    pub key: String,
    /// The type of the flag.
    pub r#type: Type,
}

impl fmt::Display for InvalidValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "The value for {} ({}) is not a {} value of the flag.\n\nTo resolve: Set {} to a value of the flag, as its declaration in the flags file describes.",
            self.key, self.env, self.r#type, self.env
        )
    }
}

impl std::error::Error for InvalidValueError {}

/// Returns the problems of `env` against `definitions`: variables with `prefix` that no flag
/// declares, values that are not values of their flag, and flags past their `expires` date at
/// `now` (milliseconds since the epoch).
pub fn check(
    definitions: &Definitions,
    env: &BTreeMap<String, String>,
    prefix: &str,
    now: i64,
) -> Vec<Issue> {
    let declared: BTreeMap<&str, (&String, &Definition)> = definitions
        .iter()
        .map(|entry| (entry.1.env.as_str(), entry))
        .collect();
    let mut issues = Vec::new();

    for (name, raw) in env {
        let Some((key, definition)) = declared.get(name.as_str()) else {
            if name.starts_with(prefix) {
                issues.push(Issue {
                    env: name.clone(),
                    key: None,
                    reason: Reason::Unknown,
                });
            }
            continue;
        };

        if decode(definition, raw, key).is_err() {
            issues.push(Issue {
                env: name.clone(),
                key: Some((*key).clone()),
                reason: Reason::Invalid,
            });
        }
    }

    for (key, definition) in definitions {
        if is_stale(definition, now) {
            issues.push(Issue {
                env: definition.env.clone(),
                key: Some(key.clone()),
                reason: Reason::Stale,
            });
        }
    }

    issues
}

/// Returns the value that `raw`, the text of an environment variable or a search parameter, holds
/// for `definition`.
///
/// # Errors
///
/// Returns [`InvalidValueError`] when `raw` is not a value of the flag.
pub fn decode(definition: &Definition, raw: &str, key: &str) -> Result<Json, InvalidValueError> {
    let value = match definition.r#type {
        Type::Boolean => match raw {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        Type::Json => serde_json::from_str(raw).ok().map(normalize),
        Type::Number => js_number(raw).and_then(number),
        Type::Select | Type::String => Some(Value::String(raw.to_owned())),
    };

    match value {
        Some(value) if validate(definition, &value) => Ok(value),
        _ => Err(InvalidValueError {
            env: definition.env.clone(),
            key: key.to_owned(),
            r#type: definition.r#type,
        }),
    }
}

/// Returns the text of `value` in an environment variable or a search parameter.
pub fn encode(value: &Json) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => value.to_string(),
    }
}

/// Returns the environment variable of a key: `newCheckout` reads `FEATURE_NEW_CHECKOUT`.
pub fn env_of(key: &str, prefix: &str) -> String {
    let mut env = String::from(prefix);
    let mut previous: Option<char> = None;

    for char in key.chars() {
        if char.is_ascii_uppercase()
            && previous
                .is_some_and(|previous| previous.is_ascii_lowercase() || previous.is_ascii_digit())
        {
            env.push('_');
        }
        env.extend(char.to_uppercase());
        previous = Some(char);
    }

    env
}

/// Returns definitions for each variable with `prefix` in `env`, for a project with no flags file.
/// Each flag is private. `true` and `false` make a boolean, a decimal makes a number, a JSON object
/// or array makes a JSON flag, and other values make a string. The value is also the default.
pub fn from_env(env: &BTreeMap<String, String>, prefix: &str) -> Definitions {
    env.iter()
        .filter(|entry| entry.0.len() > prefix.len() && entry.0.starts_with(prefix))
        .map(|(name, raw)| {
            let (r#type, default) = infer(raw);
            let definition = Definition {
                build: false,
                default,
                description: None,
                env: name.clone(),
                expires: None,
                options: None,
                public: false,
                r#type,
            };
            (key_of(name, prefix), definition)
        })
        .collect()
}

/// Returns `true` when the `expires` date of the flag is before `now` (milliseconds since the
/// epoch). The flag expires at the end of that day in UTC.
pub fn is_stale(definition: &Definition, now: i64) -> bool {
    definition
        .expires
        .as_deref()
        .and_then(day_of)
        .is_some_and(|day| day * MS_PER_DAY + MS_PER_DAY <= now)
}

/// Returns the key of an environment variable: `FEATURE_NEW_CHECKOUT` is `newCheckout`.
pub fn key_of(name: &str, prefix: &str) -> String {
    camel_case(&name.get(prefix.len()..).unwrap_or_default().to_lowercase())
}

/// Returns the definitions in a definition object, the format of the store and of the admin API.
/// Keys in `snake_case` map to `camelCase`. Every flag must declare `type` and `default`.
///
/// # Errors
///
/// Returns [`InvalidDeclarationError`] when a declaration does not follow the schema.
pub fn parse(input: &Json, prefix: &str) -> Result<Definitions, InvalidDeclarationError> {
    let Value::Object(input) = input else {
        return Err(InvalidDeclarationError {
            key: "(root)".to_owned(),
            reason: "The flags file is not an object.".to_owned(),
        });
    };

    let mut definitions = Definitions::new();
    let mut envs: BTreeMap<String, String> = BTreeMap::new();

    for (name, declaration) in input {
        if name == "$schema" {
            continue;
        }

        let key = camel_case(name);
        let definition = declare(&key, declaration, prefix)?;

        if definitions.contains_key(&key) {
            return Err(InvalidDeclarationError {
                reason: format!("The key {key} is declared twice."),
                key,
            });
        }

        if let Some(other) = envs.get(&definition.env) {
            return Err(InvalidDeclarationError {
                reason: format!(
                    "The flags {other} and {key} read the same variable {}.",
                    definition.env
                ),
                key,
            });
        }

        envs.insert(definition.env.clone(), key.clone());
        definitions.insert(key, definition);
    }

    Ok(definitions)
}

/// Returns the definitions in the text of `.env.flags`. Each variable with `prefix` declares a
/// flag, and its value is the default. Comment lines directly above it hold the description and
/// tags:
///
/// - `@type {boolean}`, `{number}`, `{string}`, `{json}`, or a union of string literals such as
///   `{'a' | 'b'}` for a select flag. Required.
/// - `@public`: the value may reach a browser.
/// - `@build`: the value resolves when the bundle builds.
/// - `@expires 2027-01-31`: the date after which the flag is due for retirement.
///
/// Several tags may share a line. Comment lines without a tag form the description.
///
/// # Errors
///
/// Returns [`InvalidDeclarationError`] when a line or a declaration is invalid. The reason names
/// the line.
pub fn parse_file(text: &str, prefix: &str) -> Result<Definitions, InvalidDeclarationError> {
    let entries = scan(text)?;
    let mut declarations: Vec<(String, usize, Map<String, Value>, bool)> = Vec::new();

    for entry in &entries {
        let fail = |key: &str, reason: String| at(key.to_owned(), &reason, entry.line);

        if entry.name.len() == prefix.len() || !entry.name.starts_with(prefix) {
            return Err(fail(
                &entry.name,
                format!("The variable {} does not start with {prefix}.", entry.name),
            ));
        }
        let key = key_of(&entry.name, prefix);

        let mut description = Vec::new();
        let mut declaration = Map::new();
        let mut r#type = None;
        declaration.insert("env".to_owned(), Value::String(entry.name.clone()));

        for comment in &entry.comments {
            let Some(tags) = tags(comment) else {
                let text = comment.trim();
                if !text.is_empty() {
                    description.push(text);
                }
                continue;
            };

            for tag in tags {
                match (
                    tag.name,
                    tag.argument.filter(|argument| !argument.is_empty()),
                ) {
                    ("type", Some(argument)) => {
                        let Some((parsed, options)) = type_of(argument) else {
                            return Err(fail(
                                &key,
                                format!("`@type {{{argument}}}` of {key} is not a flag type."),
                            ));
                        };
                        r#type = Some(parsed);
                        // As `Object.assign` in TypeScript, a later `@type` keeps earlier options.
                        if let Some(options) = options {
                            declaration.insert("options".to_owned(), Value::from(options));
                        }
                    }
                    ("type", None) => {
                        return Err(fail(
                            &key,
                            format!(
                                "`@type` of {key} needs a type in braces, such as {{boolean}}."
                            ),
                        ));
                    }
                    ("build" | "public", _) if tag.argument.is_some() => {
                        return Err(fail(
                            &key,
                            format!("`@{}` of {key} takes no value.", tag.name),
                        ));
                    }
                    ("build" | "public", _) => {
                        declaration.insert(tag.name.to_owned(), Value::Bool(true));
                    }
                    ("expires", Some(argument)) => {
                        declaration
                            .insert("expires".to_owned(), Value::String(argument.to_owned()));
                    }
                    ("expires", None) => {
                        return Err(fail(
                            &key,
                            format!("`@expires` of {key} needs a date in the form YYYY-MM-DD."),
                        ));
                    }
                    (name, _) => {
                        return Err(fail(
                            &key,
                            format!("The tag `@{name}` of {key} is not a Flargs tag."),
                        ));
                    }
                }
            }
        }

        if !description.is_empty() {
            declaration.insert(
                "description".to_owned(),
                Value::String(description.join(" ")),
            );
        }
        let Some(r#type) = r#type else {
            return Err(fail(
                &key,
                format!("The flag {key} needs a `@type` tag, such as `# @type {{boolean}}`."),
            ));
        };
        declaration.insert("type".to_owned(), Value::String(r#type.as_str().to_owned()));

        let text = Value::String(entry.value.clone());
        let default = match r#type {
            Type::Boolean => match entry.value.as_str() {
                "true" => Some(Value::Bool(true)),
                "false" => Some(Value::Bool(false)),
                _ => Some(text),
            },
            Type::Json => serde_json::from_str(&entry.value).ok().map(normalize),
            Type::Number => Some(js_number(&entry.value).and_then(number).unwrap_or(text)),
            Type::Select | Type::String => Some(text),
        };
        let parsed = default.is_some();
        declaration.insert("default".to_owned(), default.unwrap_or(Value::Null));

        if declarations.iter().any(|declaration| declaration.0 == key) {
            return Err(fail(&key, format!("The flag {key} is declared twice.")));
        }
        declarations.push((key, entry.line, declaration, parsed));
    }

    // Every line parses before any declaration validates, in file order, as in TypeScript.
    let mut definitions = Definitions::new();
    for (key, line, declaration, parsed) in declarations {
        let definition = declare(&key, &Value::Object(declaration), prefix)
            .and_then(|definition| {
                if parsed {
                    return Ok(definition);
                }
                // A JSON default that does not parse fails after every other check of the flag.
                Err(InvalidDeclarationError {
                    reason: format!("The default of {key} is not a json value."),
                    key: key.clone(),
                })
            })
            .map_err(|error| at(error.key, &error.reason, line))?;
        definitions.insert(key, definition);
    }

    Ok(definitions)
}

/// Returns `true` when `value` is a value of the flag.
pub fn validate(definition: &Definition, value: &Json) -> bool {
    match definition.r#type {
        Type::Boolean => value.is_boolean(),
        Type::Json => true,
        Type::Number => value.is_number(),
        Type::Select => value.as_str().is_some_and(|value| {
            definition
                .options
                .iter()
                .flatten()
                .any(|option| option == value)
        }),
        Type::String => value.is_string(),
    }
}

/// Returns the values that `env` sets for declared flags. A variable that a flag does not declare
/// is ignored here. [`check`] reports it.
///
/// # Errors
///
/// Returns [`InvalidValueError`] when a variable holds a value that is not a value of its flag.
pub fn values(
    definitions: &Definitions,
    env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, Json>, InvalidValueError> {
    definitions
        .iter()
        .filter_map(|(key, definition)| {
            env.get(&definition.env)
                .map(|raw| decode(definition, raw, key).map(|value| (key.clone(), value)))
        })
        .collect()
}

/// Returns an error whose reason names `line`.
fn at(key: String, reason: &str, line: usize) -> InvalidDeclarationError {
    InvalidDeclarationError {
        key,
        reason: format!(
            "{} (line {line}).",
            reason.strip_suffix('.').unwrap_or(reason)
        ),
    }
}

fn camel_case(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(char) = chars.next() {
        if char == '_'
            && let Some(next) =
                chars.next_if(|next| next.is_ascii_lowercase() || next.is_ascii_digit())
        {
            result.push(next.to_ascii_uppercase());
        } else {
            result.push(char);
        }
    }

    result
}

/// Returns the days since the epoch of a `YYYY-MM-DD` date. As `Date.parse` in JavaScript, it
/// accepts a day up to 31 in any month, and a later day rolls over into the next month.
fn day_of(date: &str) -> Option<i64> {
    let &[y1, y2, y3, y4, b'-', m1, m2, b'-', d1, d2] = date.as_bytes() else {
        return None;
    };
    let digits = |bytes: &[u8]| {
        bytes.iter().try_fold(0, |total, byte| {
            char::from(*byte)
                .to_digit(10)
                .map(|digit| total * 10 + i64::from(digit))
        })
    };

    let year = digits(&[y1, y2, y3, y4])?;
    let month = digits(&[m1, m2]).filter(|month| (1..=12).contains(month))?;
    let day = digits(&[d1, d2]).filter(|day| (1..=31).contains(day))?;

    // Days from civil, with years that start in March so that a leap day ends the year.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn declare(
    key: &str,
    declaration: &Json,
    prefix: &str,
) -> Result<Definition, InvalidDeclarationError> {
    let fail = |reason: String| InvalidDeclarationError {
        key: key.to_owned(),
        reason,
    };

    let Value::Object(declaration) = declaration else {
        return Err(fail(format!("The declaration of {key} is not an object.")));
    };

    if let Some(field) = declaration
        .keys()
        .find(|field| !FIELDS.contains(&field.as_str()))
    {
        return Err(fail(format!(
            "The declaration of {key} has an unknown field {field}."
        )));
    }

    let Some(r#type) = declaration
        .get("type")
        .and_then(Value::as_str)
        .and_then(Type::of)
    else {
        return Err(fail(format!(
            "The declaration of {key} needs a `type`: boolean, json, number, select, string."
        )));
    };
    let Some(default) = declaration.get("default") else {
        return Err(fail(format!("The declaration of {key} needs a `default`.")));
    };

    let options = match (r#type, declaration.get("options")) {
        (Type::Select, Some(Value::Array(options))) => {
            let options: Option<Vec<String>> = options
                .iter()
                .map(|option| option.as_str().map(str::to_owned))
                .collect();
            match options {
                Some(options)
                    if !options.is_empty()
                        && options.iter().collect::<BTreeSet<_>>().len() == options.len() =>
                {
                    Some(options)
                }
                _ => {
                    return Err(fail(format!(
                        "The select flag {key} needs `options`: a list of distinct strings."
                    )));
                }
            }
        }
        (Type::Select, _) => {
            return Err(fail(format!(
                "The select flag {key} needs `options`: a list of distinct strings."
            )));
        }
        (_, Some(_)) => {
            return Err(fail(format!(
                "Only a select flag declares `options`, and {key} is a {type} flag."
            )));
        }
        (_, None) => None,
    };

    let description = match declaration.get("description") {
        None => None,
        Some(Value::String(description)) => Some(description.clone()),
        Some(_) => return Err(fail(format!("`description` of {key} is not a string."))),
    };

    // As `??` in TypeScript, an explicit `null` selects the default variable.
    let env = match declaration.get("env") {
        None | Some(Value::Null) => Some(env_of(key, prefix)),
        Some(Value::String(env)) => Some(env.clone()),
        Some(_) => None,
    };
    let Some(env) = env.filter(|env| is_variable(env)) else {
        return Err(fail(format!(
            "`env` of {key} is not a variable name in SCREAMING_SNAKE_CASE."
        )));
    };

    let expires = match declaration.get("expires") {
        None => None,
        Some(Value::String(expires)) if day_of(expires).is_some() => Some(expires.clone()),
        Some(_) => {
            return Err(fail(format!(
                "`expires` of {key} is not a date in the form YYYY-MM-DD."
            )));
        }
    };

    let boolean = |field: &str| match declaration.get(field) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(fail(format!("`{field}` of {key} is not a boolean."))),
    };

    let definition = Definition {
        build: boolean("build")?,
        default: normalize(default.clone()),
        description,
        env,
        expires,
        options,
        public: boolean("public")?,
        r#type,
    };

    if !validate(&definition, &definition.default) {
        return Err(fail(if r#type == Type::Select {
            format!("The default of {key} is not one of its options.")
        } else {
            format!("The default of {key} is not a {type} value.")
        }));
    }

    Ok(definition)
}

/// One `NAME=value` line of `.env.flags`, with the comment lines directly above it.
struct Entry {
    /// The comment lines above the variable, without `#`. A blank line ends a comment block.
    comments: Vec<String>,
    /// The 1-based line number of the variable.
    line: usize,
    /// The variable name.
    name: String,
    /// The value, with surrounding quotes removed.
    value: String,
}

/// A tag in a comment line, such as `@type {'a' | 'b'}` or `@public`.
struct Tag<'a> {
    /// The text in braces, or the word after the tag, if any.
    argument: Option<&'a str>,
    /// The tag name, without `@`. Empty when the text after `@` is not a name.
    name: &'a str,
}

/// Returns the entries of `.env.flags`, or an error that names the first line that is neither
/// blank, a comment, nor `NAME=value`.
fn scan(text: &str) -> Result<Vec<Entry>, InvalidDeclarationError> {
    let mut entries = Vec::new();
    let mut comments = Vec::new();

    for (index, line) in text.split('\n').enumerate() {
        let line = js_trim(line);

        if line.is_empty() {
            comments.clear();
            continue;
        }

        if let Some(comment) = line.strip_prefix('#') {
            comments.push(
                comment
                    .strip_prefix(char::is_whitespace)
                    .unwrap_or(comment)
                    .to_owned(),
            );
            continue;
        }

        let Some((name, value)) = assignment(line) else {
            let line = index + 1;
            return Err(InvalidDeclarationError {
                key: format!("line {line}"),
                reason: format!("Line {line} is not a comment or a NAME=value line."),
            });
        };
        entries.push(Entry {
            comments: std::mem::take(&mut comments),
            line: index + 1,
            name: name.to_owned(),
            value: unquote(value),
        });
    }

    Ok(entries)
}

/// Returns the name and the raw value of a line that matches
/// `^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`.
fn assignment(line: &str) -> Option<(&str, &str)> {
    fn variable(text: &str) -> Option<(&str, &str)> {
        let rest =
            text.trim_start_matches(|char: char| char.is_ascii_alphanumeric() || char == '_');
        let name = text.strip_suffix(rest)?;
        if !name.starts_with(|char: char| char.is_ascii_alphabetic() || char == '_') {
            return None;
        }
        let value = rest.trim_start().strip_prefix('=')?.trim_start();
        Some((name, value))
    }

    line.strip_prefix("export")
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .and_then(|rest| variable(rest.trim_start()))
        .or_else(|| variable(line))
}

/// Returns the tags of a comment line that starts with `@`, or `None` for a description line.
/// Several tags may share a line: `@type {boolean} @public @build`.
fn tags(comment: &str) -> Option<Vec<Tag<'_>>> {
    let mut rest = comment.trim();
    if !rest.starts_with('@') {
        return None;
    }

    let mut tags = Vec::new();
    while !rest.is_empty() {
        let after = rest.strip_prefix('@').unwrap_or_default();
        let remainder = after.trim_start_matches(|char: char| char.is_ascii_alphabetic());
        let name = after.strip_suffix(remainder).unwrap_or_default();
        if name.is_empty() {
            tags.push(Tag {
                argument: Some(rest),
                name: "",
            });
            break;
        }
        rest = remainder.trim_start();

        let argument = if let Some(braced) = rest.strip_prefix('{') {
            // Without `}`, the brace stays in `rest`, and the next pass reports an unknown tag.
            braced.split_once('}').map(|(value, after)| {
                rest = after.trim_start();
                value.trim()
            })
        } else if !rest.is_empty() && !rest.starts_with('@') {
            let (word, after) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            rest = after.trim_start();
            Some(word)
        } else {
            None
        };

        tags.push(Tag { argument, name });
    }

    Some(tags)
}

/// Returns the type in the braces of `@type`, and the options of a select flag.
fn type_of(text: &str) -> Option<(Type, Option<Vec<String>>)> {
    let text = text.trim();
    if let Some(r#type) = Type::of(text).filter(|r#type| *r#type != Type::Select) {
        return Some((r#type, None));
    }

    let options = text
        .split('|')
        .map(|part| {
            let part = part.trim();
            let quote = part
                .chars()
                .next()
                .filter(|char| matches!(char, '\'' | '"'))?;
            part.strip_prefix(quote)?
                .strip_suffix(quote)
                .map(str::to_owned)
        })
        .collect::<Option<Vec<_>>>()?;
    Some((Type::Select, Some(options)))
}

/// Returns `value` without surrounding quotes. Double quotes decode as a JSON string.
fn unquote(value: &str) -> String {
    if let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        return serde_json::from_str(value).unwrap_or_else(|_| inner.to_owned());
    }
    value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .unwrap_or(value)
        .to_owned()
}

fn infer(raw: &str) -> (Type, Json) {
    if raw == "true" || raw == "false" {
        return (Type::Boolean, Value::Bool(raw == "true"));
    }

    if is_decimal(raw)
        && let Some(value) = raw.parse().ok().and_then(number)
    {
        return (Type::Number, value);
    }

    if (raw.starts_with('{') || raw.starts_with('['))
        && let Ok(value) = serde_json::from_str(raw)
    {
        return (Type::Json, normalize(value));
    }

    (Type::String, Value::String(raw.to_owned()))
}

/// Returns `true` for text that matches `^-?\d+(\.\d+)?$`.
fn is_decimal(raw: &str) -> bool {
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);

    match unsigned.split_once('.') {
        Some((integer, fraction)) => digits(integer) && digits(fraction),
        None => digits(unsigned),
    }
}

/// Returns `true` for text that matches `^[A-Z_][A-Z0-9_]*$`.
fn is_variable(env: &str) -> bool {
    let mut bytes = env.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Returns `text` without the whitespace that `String.prototype.trim` removes in JavaScript, which
/// includes a byte order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|char: char| char.is_whitespace() || char == '\u{feff}')
}

/// Returns the number that `Number(raw)` returns in JavaScript, or `None` for `NaN` and a blank
/// string.
fn js_number(raw: &str) -> Option<f64> {
    let text = js_trim(raw);

    let radix = match text.get(..2) {
        Some("0b" | "0B") => Some(2),
        Some("0o" | "0O") => Some(8),
        Some("0x" | "0X") => Some(16),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = text.get(2..).filter(|digits| !digits.is_empty())?;
        return digits.chars().try_fold(0.0, |total, char| {
            char.to_digit(radix)
                .map(|digit| total * f64::from(radix) + f64::from(digit))
        });
    }

    // `f64::from_str` also accepts `inf` and `NaN`, which `Number` rejects or makes non-finite.
    let numeric = text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !numeric || text.is_empty() {
        return None;
    }
    text.parse().ok()
}

/// Recursively writes integral floats as integers, as JavaScript does, so `3.0` encodes as `3`.
fn normalize(value: Json) -> Json {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Number(value) if value.is_f64() => value
            .as_f64()
            .and_then(number)
            .unwrap_or(Value::Number(value)),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        _ => value,
    }
}

/// Returns a finite number as JSON, with an integer for an integral value below 2^53.
fn number(value: f64) -> Option<Json> {
    const SAFE: f64 = 9_007_199_254_740_992.0;

    if value.fract() == 0.0 && value.abs() < SAFE {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "The value is integral and below 2^53."
        )]
        return Some(Value::from(value as i64));
    }

    serde_json::Number::from_f64(value).map(Value::Number)
}
