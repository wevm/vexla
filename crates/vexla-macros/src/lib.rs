//! The `vexla::flags!` macro. It reads `.env.flags` at compile time, parses it with
//! `vexla-definitions`, the parser that the shared vectors cover, and emits typed items that call
//! into `vexla`. Use it through the `macros` feature of `vexla`.

use std::collections::BTreeSet;
use std::path::Path;

use proc_macro::TokenStream;
use proc_macro2::{Literal, TokenStream as Tokens};
use quote::quote;
use syn::{Ident, LitStr};
use vexla_definitions::{self as definitions, Definition, Json, Type};

/// Reads `.env.flags` at compile time and generates `Flags`, one `vexla::Key` for each runtime
/// flag, one constant for each build flag, and one enum for each select flag. See `vexla::flags!`.
#[proc_macro]
pub fn flags(input: TokenStream) -> TokenStream {
    let input = syn::parse_macro_input!(input as LitStr);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn expand(input: &LitStr) -> syn::Result<Tokens> {
    let file = input.value();
    let fail = |message: String| syn::Error::new(input.span(), message);

    let root = std::env::var("CARGO_MANIFEST_DIR").map_err(|_| {
        fail("vexla::flags! needs CARGO_MANIFEST_DIR. Build with Cargo.".to_owned())
    })?;
    let path = Path::new(&root).join(&file);
    let text = std::fs::read_to_string(&path).map_err(|error| {
        fail(format!(
            "vexla::flags! cannot read {}: {error}",
            path.display()
        ))
    })?;

    let definitions =
        definitions::parse_file(&text).map_err(|error| fail(format!("{file}: {error}")))?;

    let mut constants = Vec::new();
    let mut declarations = Vec::new();
    let mut defaults = Vec::new();
    let mut enums = Vec::new();
    let mut fields = Vec::new();
    let mut names = BTreeSet::new();
    let mut reads = Vec::new();

    for (key, definition) in &definitions {
        let name = snake_case(key);
        if !names.insert(name.clone()) {
            return Err(fail(format!(
                "{file}: Two flags make the Rust field {name}. Rename one of them."
            )));
        }
        let constant = ident(key, key, &fail)?;
        let field = ident(&name, key, &fail)?;
        let docs = definition
            .description
            .clone()
            .unwrap_or_else(|| format!("The `{key}` flag."));

        let options = match &definition.options {
            Some(options) if definition.r#type == Type::Select => {
                let item = enumerate(key, &name, options, &docs, &fail)?;
                enums.push(item.tokens);
                Some(item.name)
            }
            _ => None,
        };

        declarations.push(declaration(key, definition));

        if definition.build {
            let value = match std::env::var(key) {
                Ok(raw) => definitions::decode(definition, &raw, key)
                    .map_err(|error| fail(format!("{file}: {error}")))?,
                Err(std::env::VarError::NotPresent) => definition.default.clone(),
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(fail(format!("{file}: The variable {key} is not Unicode.")));
                }
            };
            let (ty, value) = constant_of(key, definition, &value, options.as_ref(), &fail)?;

            // `option_env!` records the variable, so Cargo rebuilds the crate when it changes.
            constants.push(quote! {
                #[doc = #docs]
                pub const #constant: #ty = {
                    let _ = ::core::option_env!(#key);
                    #value
                };
            });
            continue;
        }

        let (ty, default) = field_of(key, definition, options.as_ref(), &fail)?;

        constants.push(quote! {
            #[doc = #docs]
            pub const #constant: ::vexla::Key<#ty> = ::vexla::Key::new(#key);
        });
        defaults.push(quote! { #field: #default });
        reads.push(quote! {
            #field: values
                .get(#key)
                .and_then(<#ty as ::vexla::FlagValue>::from_json)
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

        impl ::vexla::FlagSet for Flags {
            fn definitions() -> ::core::option::Option<::vexla::definitions::Definitions> {
                ::core::option::Option::Some(::core::iter::Iterator::collect(
                    ::core::iter::IntoIterator::into_iter([#(#declarations),*]),
                ))
            }

            fn from_values(values: &::vexla::Values) -> Self {
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
            ::vexla::definitions::Definition {
                build: #build,
                default: #default,
                description: #description,
                expires: #expires,
                options: #options,
                public: #public,
                r#type: ::vexla::definitions::Type::#variant,
            },
        )
    }
}

/// Returns the type and the value of a build flag constant.
fn constant_of(
    key: &str,
    definition: &Definition,
    value: &Json,
    options: Option<&Ident>,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<(Tokens, Tokens)> {
    let invalid = || fail(format!("The default of {key} has no Rust form."));

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

/// Returns the enum of a select flag, named in `PascalCase` from the `snake_case` name of the key,
/// with one variant in `PascalCase` for each option.
fn enumerate(
    key: &str,
    name: &str,
    options: &[String],
    docs: &str,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<Enum> {
    let name = ident(&pascal_case(name), key, fail)?;
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

        impl ::vexla::FlagValue for #name {
            fn from_json(json: &::vexla::Json) -> ::core::option::Option<Self> {
                match json.as_str()? {
                    #(#options => ::core::option::Option::Some(Self::#variants),)*
                    _ => ::core::option::Option::None,
                }
            }

            fn to_json(&self) -> ::vexla::Json {
                ::vexla::Json::String(::std::string::String::from(self.as_str()))
            }
        }
    };

    Ok(Enum { name, tokens })
}

/// Returns the type and the default of a runtime flag field.
fn field_of(
    key: &str,
    definition: &Definition,
    options: Option<&Ident>,
    fail: &dyn Fn(String) -> syn::Error,
) -> syn::Result<(Tokens, Tokens)> {
    Ok(match definition.r#type {
        Type::Json => (quote!(::vexla::Json), json(&definition.default)),
        Type::String => {
            let value = definitions::encode(&definition.default);
            (
                quote!(::std::string::String),
                quote!(::std::string::String::from(#value)),
            )
        }
        _ => constant_of(key, definition, &definition.default, options, fail)?,
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

/// Returns the expression that builds `value` as `vexla::Json`.
fn json(value: &Json) -> Tokens {
    match value {
        Json::Array(items) => {
            let items = items.iter().map(json);
            quote!(::vexla::Json::Array(::std::vec![#(#items),*]))
        }
        Json::Bool(value) => quote!(::vexla::Json::Bool(#value)),
        Json::Null => quote!(::vexla::Json::Null),
        Json::Number(number) => {
            let literal = match (number.as_i64(), number.as_u64(), number.as_f64()) {
                (Some(value), _, _) => Literal::i64_suffixed(value),
                (_, Some(value), _) => Literal::u64_suffixed(value),
                (_, _, value) => Literal::f64_suffixed(value.unwrap_or_default()),
            };
            quote!(::vexla::Json::from(#literal))
        }
        Json::Object(map) => {
            let keys = map.keys();
            let values = map.values().map(json);
            quote! {
                ::vexla::Json::Object(::core::iter::Iterator::collect(
                    ::core::iter::IntoIterator::into_iter([
                        #((::std::string::String::from(#keys), #values)),*
                    ])
                ))
            }
        }
        Json::String(value) => quote!(::vexla::Json::String(::std::string::String::from(#value))),
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

/// Returns lowercase `snake_case` text: `NEW_CHECKOUT` and `newCheckout` are `new_checkout`.
fn snake_case(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut previous: Option<char> = None;

    for char in text.chars() {
        if char.is_ascii_uppercase()
            && previous
                .is_some_and(|previous| previous.is_ascii_lowercase() || previous.is_ascii_digit())
        {
            result.push('_');
        }
        result.push(char.to_ascii_lowercase());
        previous = Some(char);
    }

    result
}
