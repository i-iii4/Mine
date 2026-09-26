//! Explicit local CLI adapter for the shared immutable component owner.
use mine_lib::runtime_installation::{install_development_cli, DevelopmentCliInputs};
use std::path::PathBuf;

fn parse_source(arguments: impl IntoIterator<Item = String>) -> Result<PathBuf, &'static str> {
    let mut arguments = arguments.into_iter();
    if arguments.next().as_deref() != Some("--source") {
        return Err("expected --source <absolute compiled CLI path>");
    }
    let source = arguments
        .next()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("CLI source must be absolute")?;
    if arguments.next().is_some() {
        return Err("unexpected CLI installer argument");
    }
    Ok(source)
}
fn main() {
    let result = (|| -> Result<_, String> {
        let source = parse_source(std::env::args().skip(1)).map_err(str::to_owned)?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("absolute home directory unavailable")?;
        install_development_cli(DevelopmentCliInputs {
            source,
            app_data_dir: home.join("Library/Application Support/com.mine.app"),
            entrypoint: home.join(".local/bin/mine"),
            app_version: env!("CARGO_PKG_VERSION").into(),
        })
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(report) => println!(
            "{}",
            serde_json::to_string(&report).expect("serializable CLI report")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_one_explicit_absolute_compiled_source() {
        assert_eq!(
            parse_source(["--source".into(), "/fixture/mine-cli".into()]).unwrap(),
            PathBuf::from("/fixture/mine-cli")
        );
        for values in [
            vec![],
            vec!["--source"],
            vec!["--source", "relative"],
            vec!["--source", "/fixture", "--vault", "/vault"],
        ] {
            assert!(parse_source(values.into_iter().map(str::to_owned)).is_err());
        }
    }
}
