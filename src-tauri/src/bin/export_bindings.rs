fn main() -> anyhow::Result<()> {
    mine_lib::bindings::export_types(std::env::args().any(|arg| arg == "--check"))
}
