//! `mine` — command-line access to Mine spaces. Thin shell around
//! `mine_lib::cli::run`; the logic lives in the library so tests drive it
//! against fixture vaults.

use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--runtime-probe") {
        let identity = mine_lib::runtime_protocol::RuntimeProbe {
            schema_version: 1,
            version: env!("CARGO_PKG_VERSION").into(),
            build_id: env!("MINE_BUILD_ID").into(),
            commit: env!("MINE_BUILD_COMMIT").into(),
            save_protocols: vec![mine_lib::runtime_protocol::BASE_SAVE_PROTOCOL],
        };
        println!(
            "{}",
            serde_json::to_string(&identity).expect("serializable runtime identity")
        );
        return ExitCode::SUCCESS;
    }
    let Some(env) = mine_lib::cli::CliEnv::from_system() else {
        eprintln!("cannot resolve HOME");
        return ExitCode::from(3);
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("mcp") {
        mine_lib::mcp::serve(&env);
        return ExitCode::SUCCESS;
    }
    let output = mine_lib::cli::run(&env, &args);
    print!("{}", output.stdout);
    eprint!("{}", output.stderr);
    ExitCode::from(u8::try_from(output.code).unwrap_or(1))
}
