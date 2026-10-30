//! Expands `flargs::flags!` over the fixture flags files and reads the generated items.

mod from_json {
    flargs::flags!("tests/fixtures/flags.json");
}

mod from_toml {
    flargs::flags!("tests/fixtures/flags.toml");
}

mod prefixed {
    flargs::flags!("tests/fixtures/flags.toml", env_prefix = "APP_");
}

use from_toml::{Flags, Pricing, Theme};

#[test]
#[expect(
    clippy::assertions_on_constants,
    reason = "The constants come from the flags file."
)]
fn build_constants() {
    assert!(!Flags::MAINTENANCE_BANNER);
    assert_eq!(Flags::BUILD_LIMITS, r#"{"requests":5}"#);
    assert_eq!(Flags::PACKAGE_NAME, "flargs");
    assert!(Flags::RELEASE.abs() < f64::EPSILON);
    assert_eq!(Flags::THEME, Theme::Light);
}

#[test]
fn keys() {
    assert_eq!(Flags::NEW_CHECKOUT.key(), "newCheckout");
    assert_eq!(Flags::NEW_CHECKOUT.env(), "FEATURE_NEW_CHECKOUT");
    assert_eq!(Flags::TITLE.env(), "APP_TITLE");
    assert_eq!(prefixed::Flags::NEW_CHECKOUT.env(), "APP_NEW_CHECKOUT");
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
fn json_and_toml() {
    let json = from_json::Flags::default();
    let toml = Flags::default();

    assert_eq!(json.limits, toml.limits);
    assert_eq!(json.new_checkout, toml.new_checkout);
    assert_eq!(json.pricing.as_str(), toml.pricing.as_str());
    assert_eq!(json.title, toml.title);
    assert_eq!(from_json::Flags::BUILD_LIMITS, Flags::BUILD_LIMITS);
    assert_eq!(from_json::Flags::THEME.as_str(), Flags::THEME.as_str());
}
