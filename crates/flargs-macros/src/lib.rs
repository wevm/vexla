//! The `flargs::flags!` macro. It reads `flags.toml` or `flags.json` at compile time, validates it
//! with `flargs-definitions`, the parser that the shared vectors cover, and emits typed items that
//! call into `flargs`. Use it through the `macros` feature of `flargs`.

use std::collections::BTreeSet;
use std::path::Path;

use flargs_definitions::{self as definitions, Definition, Json, Type};
use proc_macro::TokenStream;
use proc_macro2::{Literal, TokenStream as Tokens};
use quote::quote;
use syn::parse::{Parse, ParseStream};
use syn::{Ident, LitStr, Token};

/// Reads a flags file at compile time and generates `Flags`, one `flargs::Key` for each runtime
/// flag, one constant for each build flag, and one enum for each select flag. See `flargs::flags!`.
#[proc_macro]
pub fn flags(input: TokenStream) -> TokenStream {
    let input = syn::parse_macro_input!(input as Input);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

struct Input {
    path: LitStr,
    prefix: Option<LitStr>,
}

impl Parse for Input {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let path = input.parse()?;
        let mut prefix = None;

        if input.parse::<Option<Token![,]>>()?.is_some() && !input.is_empty() {
            let name: Ident = input.parse()?;
            if name != "env_prefix" {
                return Err(syn::Error::new(
                    name.span(),
                    "flargs::flags! accepts only `env_prefix = \"...\"` after the path.",
                ));
            }
            input.parse::<Token![=]>()?;
            prefix = Some(input.parse()?);
            input.parse::<Option<Token![,]>>()?;
        }

        Ok(Self { path, prefix })
    }
}

fn expand(input: &Input) -> syn::Result<Tokens> {
    let file = input.path.value();
    let fail = |message: String| syn::Error::new(input.path.span(), message);
    let prefix = input
        .prefix
        .as_ref()
        .map_or_else(|| definitions::ENV_PREFIX.to_owned(), LitStr::value);

    let root = std::env::var("CARGO_MANIFEST_DIR").map_err(|_| {
        fail("flargs::flags! needs CARGO_MANIFEST_DIR. Build with Cargo.".to_owned())
    })?;
    let path = Path::new(&root).join(&file);
    let text = std::fs::read_to_string(&path).map_err(|error| {
        fail(format!(
            "flargs::flags! cannot read {}: {error}",
            path.display()
        ))
    })?;

    let parsed = match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => serde_json::from_str(&text)
            .map_err(|error| fail(format!("{file} is not valid JSON: {error}")))
            .map(|json| definitions::parse(&json, &prefix))?,
        Some("toml") => definitions::parse_toml(&text, &prefix),
        _ => {
            return Err(fail(format!(
                "flargs::flags! reads a .toml or .json file, not {file}."
            )));
        }
    };
    let definitions = parsed.map_err(|error| fail(format!("{file}: {error}")))?;

    let mut constants = Vec::new();
    let mut declarations = Vec::new();
    let mut defaults = Vec::new();
    let mut enums = Vec::new();
    let mut fields = Vec::new();
    let mut reads = Vec::new();

    for (key, definition) in &definitions {
        let name = definitions::env_of(key, "");
        let constant = ident(&name, key, &fail)?;
        let field = ident(&name.to_lowercase(), key, &fail)?;
        let docs = definition
            .description
            .clone()
            .unwrap_or_else(|| format!("The `{key}` flag."));

        let options = match &definition.options {
            Some(options) if definition.r#type == Type::Select => {
                let item = enumerate(key, options, &docs, &fail)?;
                enums.push(item.tokens);
                Some(item.name)
            }
            _ => None,
        };

        declarations.push(declaration(key, definition));

        if definition.build {
            let value = match std::env::var(&definition.env) {
                Ok(raw) => definitions::decode(definition, &raw, key)
                    .map_err(|error| fail(format!("{file}: {error}")))?,
                Err(std::env::VarError::NotPresent) => definition.default.clone(),
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(fail(format!(
                        "{file}: The variable {} of {key} is not Unicode.",
                        definition.env
                    )));
                }
            };
            let (ty, value) = constant_of(definition, &value, options.as_ref(), &fail)?;
            let env = &definition.env;

            // `option_env!` records the variable, so Cargo rebuilds the crate when it changes.
            constants.push(quote! {
                #[doc = #docs]
                pub const #constant: #ty = {
                    let _ = ::core::option_env!(#env);
                    #value
                };
            });
            continue;
        }

        let (ty, default) = field_of(definition, options.as_ref(), &fail)?;
        let env = &definition.env;

        constants.push(quote! {
            #[doc = #docs]
            pub const #constant: ::flargs::Key<#ty> = ::flargs::Key::new(#key, #env);
        });
        defaults.push(quote! { #field: #default });
        reads.push(quote! {
            #field: values
                .get(#key)
                .and_then(<#ty as ::flargs::FlagValue>::from_json)
                .unwrap_or(defaults.#field)
        });
        fields.push(quote! {
            #[doc = #docs]
            pub #field: #ty
        });
    }

    let source = path.to_string_lossy();
    let summary = format!("The runtime flags of `{file}`.");

    Ok(quote! {
        const _: &str = ::core::include_str!(#source);

        #[doc = #summary]
        #[derive(Clone, Debug, PartialEq)]
        pub struct Flags {
            #(#fields,)*
        }

        impl Flags {
            #(#constants)*
        }

        impl ::core::default::Default for Flags {
            fn default() -> Self {
                Self {
                    #(#defaults,)*
                }
            }
        }

        impl ::flargs::FlagSet for Flags {
            fn definitions() -> ::core::option::Option<::flargs::definitions::Definitions> {
                ::core::option::Option::Some(::core::iter::Iterator::collect(
                    ::core::iter::IntoIterator::into_iter([#(#declarations),*]),
                ))
            }

            fn from_values(values: &::flargs::Values) -> Self {
                // A file with no runtime flags reads neither binding.
                let _ = values;
                let defaults = <Self as ::core::default::Default>::default();
                let _ = &defaults;
                Self {
                    #(#reads,)*
                }
            }
        }

        #(#enums)*
    })
}

/// Returns the entry of a flag in `FlagSet::definitions`: the key and the `Definition` literal.
fn declaration(key: &str, definition: &Definition) -> Tokens {
    let none = quote!(::core::option::Option::None);
    let text = |value: Option<&String>| {
        value.map_or_else(
            || none.clone(),
            |value| quote!(::core::option::Option::Some(::std::string::String::from(#value))),
        )
    };

    let build = definition.build;
    let default = json(&definition.default);
    let description = text(definition.description.as_ref());
    let env = &definition.env;
    let expires = text(definition.expires.as_ref());
    let options = definition.options.as_ref().map_or_else(
        || none.clone(),
        |options| {
            quote! {
                ::core::option::Option::Some(::std::vec![#(::std::string::String::from(#options)),*])
            }
        },
    );
    let public = definition.public;
    let variant = match definition.r#type {
        Type::Boolean => quote!(Boolean),
        Type::Json => quote!(Json),
        Type::Number => quote!(Number),
        Type::Select => quote!(Select),
        Type::String => quote!(String),
    };

    quote! {
        (
            ::std::string::String::from(#key),
            ::flargs::definitions::Definition {
                build: #build,
                default: #default,
                description: #description,
                env: ::std::string::String::from(#env),
                expires: #expires,
                options: #options,
                public: #public,
                r#type: ::flargs::definitions::Type::#variant,
            },
        )
    }
}

/// Returns the type and the value of a build flag constant.
fn constant_of(
    definition: &Definition,
    value: &Json,
    options: Option<&Ident>,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<(Tokens, Tokens)> {
    let invalid = || {
        fail(format!(
            "The default of {} has no Rust form.",
            definition.env
        ))
    };

    Ok(match (definition.r#type, value) {
        (Type::Boolean, Json::Bool(value)) => (quote!(bool), quote!(#value)),
        (Type::Json, value) => {
            let text = definitions::encode(value);
            (quote!(&'static str), quote!(#text))
        }
        (Type::Number, Json::Number(value)) => {
            let value = Literal::f64_suffixed(value.as_f64().ok_or_else(invalid)?);
            (quote!(f64), quote!(#value))
        }
        (Type::Select, Json::String(value)) => {
            let name = options.ok_or_else(invalid)?;
            let variant = ident(&pascal_case(value), value, fail)?;
            (quote!(#name), quote!(#name::#variant))
        }
        (Type::String, Json::String(value)) => (quote!(&'static str), quote!(#value)),
        _ => return Err(invalid()),
    })
}

struct Enum {
    name: Ident,
    tokens: Tokens,
}

/// Returns the enum of a select flag, with one variant in `PascalCase` for each option.
fn enumerate(
    key: &str,
    options: &[String],
    docs: &str,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<Enum> {
    let name = ident(&pascal_case(key), key, fail)?;
    let variants = options
        .iter()
        .map(|option| ident(&pascal_case(option), key, fail))
        .collect::<syn::Result<Vec<_>>>()?;

    let distinct: BTreeSet<String> = variants.iter().map(ToString::to_string).collect();
    if distinct.len() != variants.len() {
        return Err(fail(format!(
            "The options of {key} make the same Rust variant twice. Use options that differ in more than case or punctuation."
        )));
    }

    let docs = format!("The options of the `{key}` flag. {docs}");
    let tokens = quote! {
        #[doc = #docs]
        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub enum #name {
            #(#[doc = #options] #variants,)*
        }

        impl #name {
            /// Returns the option, as the flags file writes it.
            pub const fn as_str(self) -> &'static str {
                match self {
                    #(Self::#variants => #options,)*
                }
            }
        }

        impl ::flargs::FlagValue for #name {
            fn from_json(json: &::flargs::Json) -> ::core::option::Option<Self> {
                match json.as_str()? {
                    #(#options => ::core::option::Option::Some(Self::#variants),)*
                    _ => ::core::option::Option::None,
                }
            }

            fn to_json(&self) -> ::flargs::Json {
                ::flargs::Json::String(::std::string::String::from(self.as_str()))
            }
        }
    };

    Ok(Enum { name, tokens })
}

/// Returns the type and the default of a runtime flag field.
fn field_of(
    definition: &Definition,
    options: Option<&Ident>,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<(Tokens, Tokens)> {
    Ok(match definition.r#type {
        Type::Json => (quote!(::flargs::Json), json(&definition.default)),
        Type::String => {
            let value = definitions::encode(&definition.default);
            (
                quote!(::std::string::String),
                quote!(::std::string::String::from(#value)),
            )
        }
        _ => constant_of(definition, &definition.default, options, fail)?,
    })
}

/// Returns the identifier of `name`, or a raw identifier for a keyword such as `type`.
fn ident(name: &str, key: &str, fail: &dyn Fn(String) -> syn::Error) -> syn::Result<Ident> {
    syn::parse_str::<Ident>(name)
        .or_else(|_| syn::parse_str::<Ident>(&format!("r#{name}")))
        .map_err(|_| {
            fail(format!(
                "The key {key} makes no Rust identifier from {name:?}."
            ))
        })
}

/// Returns the expression that builds `value` as `flargs::Json`.
fn json(value: &Json) -> Tokens {
    match value {
        Json::Array(items) => {
            let items = items.iter().map(json);
            quote!(::flargs::Json::Array(::std::vec![#(#items),*]))
        }
        Json::Bool(value) => quote!(::flargs::Json::Bool(#value)),
        Json::Null => quote!(::flargs::Json::Null),
        Json::Number(number) => {
            let literal = match (number.as_i64(), number.as_u64(), number.as_f64()) {
                (Some(value), _, _) => Literal::i64_suffixed(value),
                (_, Some(value), _) => Literal::u64_suffixed(value),
                (_, _, value) => Literal::f64_suffixed(value.unwrap_or_default()),
            };
            quote!(::flargs::Json::from(#literal))
        }
        Json::Object(map) => {
            let keys = map.keys();
            let values = map.values().map(json);
            quote! {
                ::flargs::Json::Object(::core::iter::Iterator::collect(
                    ::core::iter::IntoIterator::into_iter([
                        #((::std::string::String::from(#keys), #values)),*
                    ])
                ))
            }
        }
        Json::String(value) => quote!(::flargs::Json::String(::std::string::String::from(#value))),
    }
}

/// Returns `PascalCase` text: each run of letters and digits starts with an uppercase letter.
fn pascal_case(text: &str) -> String {
    text.split(|char: char| !char.is_alphanumeric())
        .flat_map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .into_iter()
                .flat_map(char::to_uppercase)
                .chain(chars)
        })
        .collect()
}
