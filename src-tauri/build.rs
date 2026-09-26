fn main() {
    emit_build_identity();
    // Article audio is opt-in; without the feature the Swift helper is neither
    // compiled nor placed in `binaries/` for bundling.
    #[cfg(all(feature = "desktop", feature = "article-audio", target_os = "macos"))]
    build_article_audio_helper();

    // The iCloud progress helper is not optional: a real download percentage
    // (SPEC_CLOUD_STORAGE.md Х4) only exists in the system's ubiquitous
    // metadata, and reading it needs a run loop outside the app process. This
    // makes swiftc (Xcode Command Line Tools) a build requirement on macOS —
    // the documented price of a percent that tells the truth.
    #[cfg(all(feature = "desktop", target_os = "macos"))]
    build_icloud_progress_helper();

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
        "vite.config.ts",
        "extension/manifest.json",
    ] {
        hash_path(root, &root.join(input), &mut digest);
    }
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
    println!("cargo:rustc-env=MINE_BUILD_COMMIT={commit}");
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

/// Compile the iCloud progress helper into `binaries/` under a fixed name, so
/// it ships as a bundle resource the same way yt-dlp does and is found beside
/// the resources at runtime.
#[cfg(all(feature = "desktop", target_os = "macos"))]
fn build_icloud_progress_helper() {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    const HELPER_NAME: &str = "icloud-progress-helper";

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing OUT_DIR"));
    let source = manifest_dir
        .join("native")
        .join("icloud_progress_helper.swift");
    let binaries_dir = manifest_dir.join("binaries");
    let output = binaries_dir.join(HELPER_NAME);
    let module_cache = out_dir.join("swift-module-cache");

    println!("cargo:rerun-if-changed={}", source.display());

    std::fs::create_dir_all(&binaries_dir).expect("failed to create binaries dir");
    std::fs::create_dir_all(&module_cache).expect("failed to create swift module cache dir");

    let status = Command::new("xcrun")
        .arg("swiftc")
        .arg("-module-cache-path")
        .arg(&module_cache)
        .arg("-O")
        .arg("-o")
        .arg(&output)
        .arg(&source)
        .status()
        .expect(
            "failed to spawn swiftc for the iCloud progress helper — Xcode Command Line Tools are required",
        );

    if !status.success() {
        panic!(
            "failed to build the iCloud progress helper at {}",
            output.display()
        );
    }
}

#[cfg(all(feature = "desktop", feature = "article-audio", target_os = "macos"))]
fn build_article_audio_helper() {
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
