//! A select flag whose default is not one of its options fails the build.

vexla::flags!("../../../../crates/vexla/tests/ui/invalid_declaration.env.flags");

fn main() {}
