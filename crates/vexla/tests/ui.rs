//! Compiles the `trybuild` fixtures in `tests/ui/`, which `vexla::flags!` must reject.
//!
//! `trybuild` builds each fixture in `target/tests/trybuild/vexla`, which is its
//! `CARGO_MANIFEST_DIR`, so the fixtures name their flags file relative to that directory.

#[test]
fn ui() {
    trybuild::TestCases::new().compile_fail("tests/ui/*.rs");
}
