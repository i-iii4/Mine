fn main() {
    emit_build_identity();
    // One minimum macOS for everything Mine ships, read once from
    // tauri.conf.json (user's decision of 01.11.2026); None off macOS.
    let macos_minimum = macos_minimum_system_version();
    if let Some(minimum) = &macos_minimum {
        // Every binary of this package (the app, native-host, the CLI and
        // the tooling) links for that minimum in every build. tauri-build
        // emits the same line only when `tauri` has `custom-protocol`
        // (`cargo tauri build`); native-host is also built without the
        // `desktop` feature (`clipper:install-host`), and any other build
        // would link for rustc's default.
        println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET={minimum}");
    }

    #[cfg(all(feature = "desktop", target_os = "macos"))]
    {
        let swift_target = swift_target(macos_minimum.as_deref());

        // Article audio is opt-in; without the feature the Swift helper is
        // neither compiled nor placed in `binaries/` for bundling.
        #[cfg(feature = "article-audio")]
        build_article_audio_helper(&swift_target);

        // The iCloud progress helper is not optional: a real download
        // percentage (SPEC_CLOUD_STORAGE.md Х4) only exists in the system's
        // ubiquitous metadata, and reading it needs a run loop outside the
        // app process. This makes swiftc (Xcode Command Line Tools) a build
        // requirement on macOS — the documented price of a percent that
        // tells the truth.
        build_swift_helper("icloud_progress_helper.swift", "icloud-progress-helper", &swift_target);

        // The unresolved iCloud conflict versions of a space's notes exist
        // only as NSFileVersion records, which only Foundation reads and
        // settles. See SPEC_ICLOUD_CONFLICTS.md, ВК5.
        build_swift_helper("icloud_conflicts_helper.swift", "icloud-conflicts-helper", &swift_target);

        // Download Media joins YouTube's separate video and audio streams
        // without ffmpeg, through AVFoundation. See SPEC_MEDIA_ASSET_ACTIONS.md.
        build_swift_helper("video_mux_helper.swift", "video-mux-helper", &swift_target);
    }

    #[cfg(feature = "desktop")]
    {
        ensure_clipper_runtime_manifest_placeholder();
        tauri_build::build();
    }
}

/// Bind the running executable to its source inputs, including uncommitted work.
/// This identity is diagnostic, not a version ordering or a signing substitute.
fn emit_build_identity() {
    use sha2::{Digest, Sha256};
    use std::{path::Path, process::Command};

    fn hash_path(root: &Path, path: &Path, digest: &mut Sha256) {
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            let mut entries: Vec<_> = std::fs::read_dir(path)
                .expect("cannot enumerate build identity input")
                .map(|entry| entry.expect("cannot read build identity entry").path())
                .collect();
            entries.sort();
            for entry in entries {
                hash_path(root, &entry, digest);
            }
        } else if path.is_file() {
            let relative = path.strip_prefix(root).expect("input outside workspace");
            let bytes = std::fs::read(path).expect("cannot read build identity input");
            digest.update(relative.to_string_lossy().as_bytes());
            digest.update([0]);
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
    }

    let manifest = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("missing manifest directory"),
    );
    let root = manifest.parent().expect("missing workspace root");
    let mut digest = Sha256::new();
    for input in [
        "Cargo.toml",
        "Cargo.lock",
        "src-tauri/Cargo.toml",
        "src-tauri/build.rs",
        "src-tauri/tauri.conf.json",
        "src-tauri/src",
        "src-tauri/native",
        "mine-core/Cargo.toml",
        "mine-core/src",
        "src",
        "public",
        "package.json",
        "bun.lock",
        "index.html",
        "settings.html",
        "tabbar.html",
        "vite.config.ts",
        "extension/manifest.json",
    ] {
        hash_path(root, &root.join(input), &mut digest);
    }
    // The source alone, before the features and the profile: the app and the
    // CLI of one checkout are different builds of the same source, and only
    // a different source is worth a warning (SPEC_DEEP_AUDIT.md, Е2.25).
    let source = digest.clone().finalize();
    let mut environment: Vec<_> = std::env::vars()
        .filter(|(key, _)| {
            key.starts_with("CARGO_FEATURE_") || matches!(key.as_str(), "TARGET" | "PROFILE")
        })
        .collect();
    environment.sort();
    for (key, value) in environment {
        digest.update(key.as_bytes());
        digest.update([0]);
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    let commit = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "source-archive".to_string());
    if let Ok(output) = Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .current_dir(root)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout);
            println!(
                "cargo:rerun-if-changed={}",
                root.join(path.trim()).display()
            );
        }
    }
    if let Ok(reference) = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .current_dir(root)
        .output()
    {
        if reference.status.success() {
            let reference = String::from_utf8_lossy(&reference.stdout);
            if let Ok(path) = Command::new("git")
                .args(["rev-parse", "--git-path", reference.trim()])
                .current_dir(root)
                .output()
            {
                if path.status.success() {
                    let path = String::from_utf8_lossy(&path.stdout);
                    println!(
                        "cargo:rerun-if-changed={}",
                        root.join(path.trim()).display()
                    );
                }
            }
        }
    }
    println!("cargo:rustc-env=MINE_BUILD_ID={:x}", digest.finalize());
    println!("cargo:rustc-env=MINE_SOURCE_ID={source:x}");
    println!("cargo:rustc-env=MINE_BUILD_COMMIT={commit}");
}

/// The minimum macOS of Mine when the target is macOS: the
/// `bundle.macOS.minimumSystemVersion` of tauri.conf.json, which Tauri also
/// writes into Info.plist as `LSMinimumSystemVersion`. It is the one source:
/// the Rust binaries and the Swift helpers take it from here, so no second
/// literal can drift from the bundle's. A missing or malformed value stops
/// the build: Tauri's own default (10.13) would silently differ.
fn macos_minimum_system_version() -> Option<String> {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return None;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
    );
    let config_path = manifest_dir.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let text = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", config_path.display()));
    let config: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", config_path.display()));
    let minimum = config
        .pointer("/bundle/macOS/minimumSystemVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| {
            panic!(
                "{} has no bundle.macOS.minimumSystemVersion: the minimum macOS of Mine",
                config_path.display()
            )
        });
    let well_formed = (1..=3).contains(&minimum.split('.').count())
        && minimum
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    assert!(
        well_formed,
        "bundle.macOS.minimumSystemVersion in {} is not a macOS version: {minimum:?}",
        config_path.display()
    );
    Some(minimum.to_string())
}

/// The swiftc target for the cargo target's architecture at Mine's minimum
/// macOS: without it swiftc builds for the build machine's macOS.
#[cfg(all(feature = "desktop", target_os = "macos"))]
fn swift_target(macos_minimum: Option<&str>) -> String {
    let minimum = macos_minimum.expect("Swift helpers are built only for a macOS target");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH")
        .expect("missing CARGO_CFG_TARGET_ARCH")
        .as_str()
    {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("no Swift target for the macOS architecture {other}"),
    };
    format!("{arch}-apple-macosx{minimum}")
}

/// Tauri validates configured resources before compiling the application,
/// while the real native-host digest only exists after compilation. Keep an
/// ignored placeholder available for Cargo builds; `beforeBundleCommand`
/// replaces it with the verified platform-specific manifest before packaging.
#[cfg(feature = "desktop")]
fn ensure_clipper_runtime_manifest_placeholder() {
    use std::path::PathBuf;

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let path = manifest_dir
        .parent()
        .expect("src-tauri has no project parent")
        .join("build/clipper-runtime-manifest.json");
    if path.is_file() {
        return;
    }
    std::fs::create_dir_all(path.parent().expect("runtime manifest has no parent"))
        .expect("failed to create runtime manifest directory");
    std::fs::write(
        path,
        b"{\n  \"schema_version\": 1,\n  \"build_profile\": \"placeholder\",\n  \"app_version\": \"__generated_by_before_bundle__\",\n  \"native_host\": { \"sha256\": \"\", \"bytes\": 0 },\n  \"extension\": { \"sha256\": \"\", \"bytes\": 0 },\n  \"ytdlp\": null\n}\n",
    )
    .expect("failed to write runtime manifest placeholder");
}

/// Compile a Swift helper from `native/` into `binaries/` under a fixed name,
/// so it ships as a bundle resource the same way yt-dlp does and is found
/// beside the resources at runtime.
#[cfg(all(feature = "desktop", target_os = "macos"))]
fn build_swift_helper(source_name: &str, helper_name: &str, swift_target: &str) {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing OUT_DIR"));
    let source = manifest_dir.join("native").join(source_name);
    let binaries_dir = manifest_dir.join("binaries");
    let output = binaries_dir.join(helper_name);
    let module_cache = out_dir.join("swift-module-cache");

    println!("cargo:rerun-if-changed={}", source.display());

    std::fs::create_dir_all(&binaries_dir).expect("failed to create binaries dir");
    std::fs::create_dir_all(&module_cache).expect("failed to create swift module cache dir");

    let status = Command::new("xcrun")
        .arg("swiftc")
        .arg("-target")
        .arg(swift_target)
        .arg("-module-cache-path")
        .arg(&module_cache)
        .arg("-O")
        .arg("-o")
        .arg(&output)
        .arg(&source)
        .status()
        .unwrap_or_else(|error| {
            panic!("failed to spawn swiftc for {helper_name} ({error}): Xcode Command Line Tools are required")
        });

    if !status.success() {
        panic!("failed to build {helper_name} at {}", output.display());
    }
}

#[cfg(all(feature = "desktop", feature = "article-audio", target_os = "macos"))]
fn build_article_audio_helper(swift_target: &str) {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    const HELPER_BASENAME: &str = "article-audio-helper";

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let target = env::var("TARGET").expect("missing TARGET");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing OUT_DIR"));
    let source = manifest_dir
        .join("native")
        .join("article_audio_helper.swift");
    let binaries_dir = manifest_dir.join("binaries");
    let output = binaries_dir.join(format!("{HELPER_BASENAME}-{target}"));
    let module_cache = out_dir.join("swift-module-cache");

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-env=ARTICLE_AUDIO_HELPER_BINARY_NAME={HELPER_BASENAME}-{target}");

    std::fs::create_dir_all(&binaries_dir).expect("failed to create binaries dir");
    std::fs::create_dir_all(&module_cache).expect("failed to create swift module cache dir");

    let status = Command::new("xcrun")
        .arg("swiftc")
        .arg("-target")
        .arg(swift_target)
        .arg("-module-cache-path")
        .arg(&module_cache)
        .arg("-parse-as-library")
        .arg("-O")
        .arg("-o")
        .arg(&output)
        .arg(&source)
        .status()
        .expect("failed to spawn swiftc for article-audio helper");

    if !status.success() {
        panic!(
            "failed to build article-audio helper at {}",
            output.display()
        );
    }
}
