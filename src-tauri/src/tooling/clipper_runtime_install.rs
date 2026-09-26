//! Explicit developer adapter for the same runtime owner used by the app.
//! Parsing has no filesystem side effects and never accepts a vault target.

use std::path::PathBuf;

use mine_lib::{install_development_runtime, DevelopmentRuntimeInputs};

#[derive(Debug, thiserror::Error)]
enum ArgumentsError {
    #[error("missing required argument {0}")]
    Missing(&'static str),
    #[error("duplicate argument {0}")]
    Duplicate(&'static str),
    #[error("unknown argument {0}")]
    Unknown(String),
    #[error("the home directory is unavailable")]
    NoHome,
}

fn parse_inputs(
    arguments: impl IntoIterator<Item = String>,
    app_data_dir: PathBuf,
) -> Result<DevelopmentRuntimeInputs, ArgumentsError> {
    let mut arguments = arguments.into_iter();
    let mut native_host = None;
    let mut extension = None;
    let mut ytdlp = None;
    while let Some(argument) = arguments.next() {
        let (slot, flag) = match argument.as_str() {
            "--host" => (&mut native_host, "--host"),
            "--extension" => (&mut extension, "--extension"),
            "--ytdlp" => (&mut ytdlp, "--ytdlp"),
            _ => return Err(ArgumentsError::Unknown(argument)),
        };
        if slot.is_some() {
            return Err(ArgumentsError::Duplicate(flag));
        }
        let value = arguments.next().ok_or(ArgumentsError::Missing(flag))?;
        if value.starts_with("--") {
            return Err(ArgumentsError::Missing(flag));
        }
        *slot = Some(PathBuf::from(value));
    }
    Ok(DevelopmentRuntimeInputs {
        native_host: native_host.ok_or(ArgumentsError::Missing("--host"))?,
        extension: extension.ok_or(ArgumentsError::Missing("--extension"))?,
        ytdlp,
        app_data_dir,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

fn main() {
    let result = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or(ArgumentsError::NoHome)
        .and_then(|home| {
            parse_inputs(
                std::env::args().skip(1),
                home.join("Library/Application Support/com.mine.app"),
            )
        });
    let inputs = match result {
        Ok(inputs) => inputs,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    match install_development_runtime(inputs) {
        Ok(report) => match serde_json::to_string(&report) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("failed to encode installation report: {error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_only_explicit_source_artifacts_for_the_shared_owner() {
        let inputs = parse_inputs(
            arguments(&[
                "--host",
                "/fixture/native-host",
                "--extension",
                "/fixture/extension",
                "--ytdlp",
                "/fixture/ytdlp",
            ]),
            PathBuf::from("/fixture/app-data"),
        )
        .expect("explicit test inputs");
        assert_eq!(inputs.native_host, PathBuf::from("/fixture/native-host"));
        assert_eq!(inputs.extension, PathBuf::from("/fixture/extension"));
        assert_eq!(inputs.app_data_dir, PathBuf::from("/fixture/app-data"));
    }

    #[test]
    fn refuses_missing_duplicate_unknown_and_vault_arguments() {
        for args in [
            arguments(&[]),
            arguments(&["--host"]),
            arguments(&["--host", "--extension", "/fixture/extension"]),
            arguments(&["--host", "/fixture/host", "--host", "/fixture/other"]),
            arguments(&["--vault", "/fixture/vault"]),
            arguments(&["--app-data-dir", "/fixture/app-data"]),
        ] {
            assert!(parse_inputs(args, PathBuf::from("/fixture/app-data")).is_err());
        }
    }
}
