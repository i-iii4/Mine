// Where the shipped yt-dlp lives (SPEC_ONBOARDING.md, О8.1): the vendor's
// unpacked build as one directory, its launcher inside under a stable name.
// The same names are in the Rust side, `src-tauri/src/tool_process.rs`.

/** The directory in `binaries/`, in the bundle's resources and in the clipper's package. */
export const YTDLP_DIRECTORY = 'yt-dlp-onedir';
/** The launcher inside it. */
export const YTDLP_EXECUTABLE = 'yt-dlp';
