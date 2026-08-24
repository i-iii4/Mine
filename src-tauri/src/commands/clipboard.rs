//! Reading the system clipboard for paste-into-feed (⌘V).
//!
//! One command answers "what is on the clipboard" with the highest-value
//! reading: file paths beat an image beats text, because copying a file in
//! Finder also leaves an icon bitmap and the file name as text on the board,
//! and a browser image copy leaves the source URL as text next to the bitmap.

use serde::Serialize;

use super::state::CommandError;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipboardPayload {
    /// Files copied in Finder — their absolute paths.
    Files { paths: Vec<String> },
    /// A bitmap (screenshot, browser image copy), saved to a temporary PNG.
    Image { path: String },
    /// Plain text.
    Text { text: String },
    /// Nothing usable.
    Empty,
}

#[tauri::command(rename_all = "snake_case")]
pub fn read_clipboard_payload() -> Result<ClipboardPayload, CommandError> {
    read_payload()
}

#[cfg(target_os = "macos")]
fn read_payload() -> Result<ClipboardPayload, CommandError> {
    use objc2_app_kit::{
        NSFilenamesPboardType, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString,
        NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSArray, NSString};

    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();

        if let Some(list) = pasteboard.propertyListForType(NSFilenamesPboardType) {
            if let Ok(array) = list.downcast::<NSArray>() {
                let paths: Vec<String> = array
                    .iter()
                    .filter_map(|item| item.downcast::<NSString>().ok())
                    .map(|s| s.to_string())
                    .filter(|p| !p.is_empty())
                    .collect();
                if !paths.is_empty() {
                    return Ok(ClipboardPayload::Files { paths });
                }
            }
        }

        if let Some(png) = pasteboard.dataForType(NSPasteboardTypePNG) {
            return Ok(ClipboardPayload::Image {
                path: write_temp_image(&png.to_vec(), false)?,
            });
        }
        if let Some(tiff) = pasteboard.dataForType(NSPasteboardTypeTIFF) {
            return Ok(ClipboardPayload::Image {
                path: write_temp_image(&tiff.to_vec(), true)?,
            });
        }

        if let Some(text) = pasteboard.stringForType(NSPasteboardTypeString) {
            let text = text.to_string();
            if !text.trim().is_empty() {
                return Ok(ClipboardPayload::Text { text });
            }
        }

        Ok(ClipboardPayload::Empty)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_payload() -> Result<ClipboardPayload, CommandError> {
    Ok(ClipboardPayload::Empty)
}

/// Save clipboard bitmap bytes as a temporary PNG the block importer can copy
/// from. TIFF (the common interchange type) is transcoded; PNG is written as
/// is. The OS owns the temp directory's lifetime.
#[cfg(target_os = "macos")]
fn write_temp_image(bytes: &[u8], is_tiff: bool) -> Result<String, CommandError> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("mine-pasted-{stamp}.png"));
    if is_tiff {
        let decoded = image::load_from_memory(bytes)
            .map_err(|e| CommandError::Internal(format!("clipboard image decode failed: {e}")))?;
        decoded
            .save_with_format(&path, image::ImageFormat::Png)
            .map_err(|e| CommandError::Internal(format!("clipboard image save failed: {e}")))?;
    } else {
        std::fs::write(&path, bytes)
            .map_err(|e| CommandError::Internal(format!("clipboard image save failed: {e}")))?;
    }
    Ok(path.to_string_lossy().to_string())
}
