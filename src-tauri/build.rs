fn main() {
    // Article audio is opt-in; without the feature the Swift helper is neither
    // compiled nor placed in `binaries/` for bundling.
    #[cfg(all(feature = "desktop", feature = "article-audio", target_os = "macos"))]
    build_article_audio_helper();

    #[cfg(feature = "desktop")]
    tauri_build::build();
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
