fn main() {
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
    tauri_build::build();
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
