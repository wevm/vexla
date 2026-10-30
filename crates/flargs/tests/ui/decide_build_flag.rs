//! A build flag has no `Key`, so `decide` rejects it.

flargs::flags!("../../../../crates/flargs/tests/ui/decide_build_flag.env.flags");

fn main() {
    let _ = flargs::Runtime::<Flags>::builder().decide(Flags::BANNER, |(): &()| Some(true));
}
