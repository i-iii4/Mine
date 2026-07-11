use anyhow::{bail, Context, Result};
use mine_lib::storage::cold_space_audit::{run_cold_space_audit, write_sanitized_fixture};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let source = args
        .next()
        .map(PathBuf::from)
        .context("usage: cold-space-audit <source-root> <empty-derived-base> [cycles] [--full] [--fixture-count N] [--browser-output PATH]")?;
    let derived = args
        .next()
        .map(PathBuf::from)
        .context("usage: cold-space-audit <source-root> <empty-derived-base> [cycles] [--full] [--fixture-count N] [--browser-output PATH]")?;
    let mut cycles = 2usize;
    let mut full = false;
    let mut fixture_count = None;
    let mut browser_output = None;
    while let Some(arg) = args.next() {
        if arg == "--full" {
            full = true;
            continue;
        }
        if arg == "--fixture-count" {
            let raw = args
                .next()
                .context("--fixture-count requires a block count")?;
            let raw = raw.to_string_lossy();
            fixture_count = Some(
                raw.parse::<usize>()
                    .with_context(|| format!("invalid fixture count: {raw}"))?,
            );
            continue;
        }
        if arg == "--browser-output" {
            browser_output = Some(
                args.next()
                    .map(PathBuf::from)
                    .context("--browser-output requires a path")?,
            );
            continue;
        }
        let raw = arg.to_string_lossy();
        cycles = raw
            .parse::<usize>()
            .with_context(|| format!("invalid cycle count: {raw}"))?;
    }
    if cycles < 2 {
        bail!("cold-space acceptance requires at least two cycles");
    }
    if let Some(count) = fixture_count {
        write_sanitized_fixture(&source, count)?;
    }

    let report = run_cold_space_audit(&source, &derived, cycles)?;
    if let Some(path) = browser_output {
        let payload = serde_json::to_vec_pretty(&report.browser_payload())?;
        std::fs::write(&path, payload)
            .with_context(|| format!("write browser payload: {}", path.display()))?;
    }
    let json = if full {
        serde_json::to_string_pretty(&report)?
    } else {
        serde_json::to_string_pretty(&report.summary())?
    };
    println!("{json}");
    Ok(())
}
