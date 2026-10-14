use anyhow::{bail, Context, Result};
use mine_lib::storage::cold_space_audit::{
    run_cold_space_audit_with_icloud, write_sanitized_fixture, COLD_ICLOUD_IMAGE,
};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let source = args
        .next()
        .map(PathBuf::from)
        .context("usage: cold-space-audit <source-root> <empty-derived-base> [cycles] [--full] [--fixture-count N] [--icloud-media] [--browser-output PATH]")?;
    let derived = args
        .next()
        .map(PathBuf::from)
        .context("usage: cold-space-audit <source-root> <empty-derived-base> [cycles] [--full] [--fixture-count N] [--icloud-media] [--browser-output PATH]")?;
    let mut cycles = 2usize;
    let mut full = false;
    let mut fixture_count = None;
    let mut browser_output = None;
    // The sanitized fixture's own picture stands for one iCloud holds
    // (SPEC_DEEP_AUDIT.md, Е7.8).
    let mut icloud_media = false;
    while let Some(arg) = args.next() {
        if arg == "--icloud-media" {
            icloud_media = true;
            continue;
        }
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

    let in_icloud: &[&str] = if icloud_media { &[COLD_ICLOUD_IMAGE] } else { &[] };
    let report = run_cold_space_audit_with_icloud(&source, &derived, cycles, in_icloud)?;
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
