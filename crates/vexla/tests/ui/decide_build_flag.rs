//! A build flag has no `Key`, so `decide` rejects it.

vexla::flags!("../../../../crates/vexla/tests/ui/decide_build_flag.env.flags");

fn main() {
    let _ = vexla::Runtime::<Flags>::builder().decide(Flags::BANNER, |(): &()| Some(true));
}
