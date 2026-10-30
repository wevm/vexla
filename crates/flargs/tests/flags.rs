//! Expands `flargs::flags!` over the fixture `.env.flags` files and reads the generated items.

mod default {
    flargs::flags!("tests/fixtures/flags.env.flags");
}

mod cargo {
    flargs::flags!("tests/fixtures/cargo.env.flags");
}

use default::{Flags, Pricing, Theme};

#[test]
#[expect(
    clippy::assertions_on_constants,
    reason = "The constants come from the flags file."
)]
fn build_constants() {
    assert!(!Flags::MAINTENANCE_BANNER);
    assert_eq!(Flags::BUILD_LIMITS, r#"{"requests":5}"#);
    assert_eq!(Flags::THEME, Theme::Light);
    assert_eq!(cargo::Flags::CARGO_PKG_NAME, "flargs");
    assert!(cargo::Flags::CARGO_PKG_VERSION_MAJOR.abs() < f64::EPSILON);
}

#[test]
fn keys() {
    assert_eq!(Flags::NEW_CHECKOUT.key(), "NEW_CHECKOUT");
    assert_eq!(
        cargo::Flags::CARGO_PKG_DESCRIPTION.key(),
        "CARGO_PKG_DESCRIPTION"
    );
}

#[test]
fn defaults() {
    let flags = Flags::default();

    assert_eq!(
        flags.limits,
        serde_json::json!({ "regions": ["eu", "us"], "requests": 100 })
    );
    assert!(!flags.new_checkout);
    assert_eq!(flags.pricing, Pricing::A);
    assert!((flags.retries - 2.5).abs() < f64::EPSILON);
    assert_eq!(flags.title, "Hello");
}

#[test]
fn select_enums() {
    assert_eq!(Pricing::C.as_str(), "c");
    assert_eq!(Theme::HighContrast.as_str(), "high-contrast");
}

#[test]
fn flag_set() {
    use flargs::FlagSet as _;

    let parsed = flargs::definitions::parse_file(include_str!("fixtures/flags.env.flags"))
        .expect("valid definitions");
    assert_eq!(Flags::definitions(), Some(parsed));

    let values = flargs::Values::from_iter([
        ("NEW_CHECKOUT".to_owned(), serde_json::json!(true)),
        ("PRICING".to_owned(), serde_json::json!("c")),
        ("TITLE".to_owned(), serde_json::json!(42)),
    ]);
    let flags = Flags::from_values(&values);
    assert!(flags.new_checkout);
    assert_eq!(flags.pricing, Pricing::C);
    assert_eq!(flags.title, "Hello");
}
