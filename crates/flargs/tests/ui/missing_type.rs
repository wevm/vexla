//! A flag without `@type` fails the build.

flargs::flags!("../../../../crates/flargs/tests/ui/missing_type.env.flags");

fn main() {}
