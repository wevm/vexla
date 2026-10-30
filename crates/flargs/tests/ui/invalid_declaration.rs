//! A select flag whose default is not one of its options fails the build.

flargs::flags!("../../../../crates/flargs/tests/ui/invalid_declaration.toml");

fn main() {}
