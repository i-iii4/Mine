//! A known space opened from Finder or the extension is shown in a tab
//! (SPEC_TABS.md, В72).
fn requested_space(url: &tauri::Url, known: &[String]) -> Option<String> {
    let path = url.to_file_path().ok()?;
    known.iter().find(|candidate| std::path::Path::new(candidate) == path).cloned()
}

/// A folder of a known space opened from Finder or the extension: the
/// backend shows it in a tab (SPEC_TABS.md, В72); before the windows are
/// restored the request waits for them there.
pub fn receive(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let known = super::vault::load_known_vaults(app);
    for url in urls {
        if let Some(path) = requested_space(url, &known) {
            crate::tabs::open_space_from_outside(app, std::path::Path::new(&path));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_registered_file_urls_including_unicode_and_spaces() {
        let path = "/tmp/Моё пространство #1".to_string();
        let url = tauri::Url::from_file_path(&path).expect("file URL");
        assert_eq!(requested_space(&url, &[path.clone()]), Some(path));
        assert_eq!(requested_space(&url, &[]), None);
        assert_eq!(requested_space(&tauri::Url::parse("https://example.com").expect("url"), &[]), None);
    }
}
