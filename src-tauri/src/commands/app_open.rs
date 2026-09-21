//! OS open requests are retained until the main frontend is ready.
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use super::state::CommandError;

#[derive(Default)]
pub struct PendingSpace(pub Mutex<Option<String>>);

fn requested_space(url: &tauri::Url, known: &[String]) -> Option<String> {
    let path = url.to_file_path().ok()?;
    known.iter().find(|candidate| std::path::Path::new(candidate) == path).cloned()
}

pub fn receive(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let known = super::vault::list_known_vaults(app.clone());
    for url in urls {
        if let Some(path) = requested_space(url, &known) {
            match app.state::<PendingSpace>().0.lock() {
                Ok(mut pending) => *pending = Some(path),
                Err(error) => { log::error!("open space lock: {error}"); continue; }
            }
            if let Err(error) = app.emit("open-space-requested", ()) {
                log::error!("open space notification: {error}");
            }
        }
    }
}

#[tauri::command]
pub fn take_open_space_request(state: tauri::State<'_, PendingSpace>) -> Result<Option<String>, CommandError> {
    state.0.lock().map(|mut pending| pending.take())
        .map_err(|error| CommandError::Internal(error.to_string()))
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
