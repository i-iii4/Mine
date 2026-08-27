//! `mine` — command-line access to Mine spaces. Thin shell around
//! `mine_lib::cli::run`; the logic lives in the library so tests drive it
//! against fixture vaults.

use std::process::ExitCode;

fn main() -> ExitCode {
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
