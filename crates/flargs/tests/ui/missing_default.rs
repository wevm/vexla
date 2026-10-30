//! A flag without `default` fails the build.

flargs::flags!("../../../../crates/flargs/tests/ui/missing_default.toml");

fn main() {}
