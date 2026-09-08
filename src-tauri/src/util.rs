// Shared utilities used by both the Tauri app and the native messaging host.

#[cfg(feature = "desktop")]
use std::io::Write;
#[cfg(feature = "desktop")]
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;
#[cfg(feature = "desktop")]
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    time::Duration,
};

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

static PROCESS_STARTED: OnceLock<Instant> = OnceLock::new();
static LAUNCH_ID: OnceLock<String> = OnceLock::new();
#[cfg(feature = "desktop")]
static STARTUP_TRACE_LOCK: Mutex<()> = Mutex::new(());

/// Start the monotonic launch clock before Tauri performs any setup work.
pub fn mark_process_started() {
    PROCESS_STARTED.get_or_init(Instant::now);
    LAUNCH_ID.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        format!("{}-{nanos}", std::process::id())
    });
}

#[cfg(feature = "desktop")]
fn launch_elapsed_ms() -> u128 {
    PROCESS_STARTED
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
}

#[cfg(feature = "desktop")]
fn launch_id() -> &'static str {
    mark_process_started();
    LAUNCH_ID.get().map_or("unknown", String::as_str)
}

#[cfg(feature = "desktop")]
pub enum SingleInstanceAcquire {
    Primary(SingleInstanceGuard),
    Secondary,
}

#[cfg(all(feature = "desktop", unix))]
pub struct SingleInstanceGuard {
    _listener: TcpListener,
}

#[cfg(all(feature = "desktop", not(unix)))]
pub struct SingleInstanceGuard {
    _listener: TcpListener,
}

#[cfg(feature = "desktop")]
pub fn acquire_single_instance(identifier: &str) -> io::Result<SingleInstanceAcquire> {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, single_instance_port(identifier));
    acquire_single_instance_at(addr)
}

#[cfg(feature = "desktop")]
fn single_instance_port(identifier: &str) -> u16 {
    let hash = identifier.bytes().fold(0u16, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(u16::from(byte))
    });
    43000 + (hash % 1000)
}

#[cfg(feature = "desktop")]
fn acquire_single_instance_at(addr: SocketAddrV4) -> io::Result<SingleInstanceAcquire> {
    match TcpListener::bind(addr) {
        Ok(listener) => Ok(SingleInstanceAcquire::Primary(SingleInstanceGuard {
            _listener: listener,
        })),
        Err(err) if err.kind() == io::ErrorKind::AddrInUse => {
            match TcpStream::connect_timeout(&addr.into(), Duration::from_millis(75)) {
                Ok(_) => Ok(SingleInstanceAcquire::Secondary),
                Err(connect_err) if connect_err.kind() == io::ErrorKind::ConnectionRefused => {
                    Err(err)
                }
                Err(connect_err) if connect_err.kind() == io::ErrorKind::TimedOut => {
                    Ok(SingleInstanceAcquire::Secondary)
                }
                Err(connect_err) => Err(connect_err),
            }
        }
        Err(err) => Err(err),
    }
}

/// Current UTC time as ISO 8601 string (without chrono dependency).
pub fn now_iso8601() -> String {
    system_time_to_iso8601(std::time::SystemTime::now())
}

/// Convert a SystemTime to UTC ISO 8601 string (without chrono dependency).
pub fn system_time_to_iso8601(time: std::time::SystemTime) -> String {
    let now = time
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is set before Unix epoch")
        .as_secs();
    let secs_per_day = 86400u64;
    let days = now / secs_per_day;
    let rem = now % secs_per_day;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let seconds = rem % 60;
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

#[cfg(feature = "desktop")]
fn startup_trace_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("startup-trace.log"))
}

#[cfg(feature = "desktop")]
pub fn reset_startup_trace(app: &AppHandle) {
    let _guard = STARTUP_TRACE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(path) = startup_trace_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, "");
}

#[cfg(feature = "desktop")]
pub fn append_startup_trace(app: &AppHandle, scope: &str, message: &str) {
    let _guard = STARTUP_TRACE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(path) = startup_trace_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "{} launch_id={} launch_elapsed_ms={} [{}] {}",
        now_iso8601(),
        launch_id(),
        launch_elapsed_ms(),
        scope,
        startup_trace_message(scope, message, cfg!(debug_assertions))
    );
}

#[cfg(feature = "desktop")]
fn startup_trace_message(scope: &str, message: &str, detailed: bool) -> String {
    if detailed || matches!(scope, "process" | "setup" | "window" | "startup") {
        return message.to_string();
    }
    if scope == "startup_maintenance" && message.starts_with("done ") {
        return message.to_string();
    }
    message
        .split_ascii_whitespace()
        .next()
        .unwrap_or("event")
        .to_string()
}

/// Convert days since Unix epoch to (year, month, day).
/// Howard Hinnant's civil_from_days algorithm.
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "desktop")]
    use super::{single_instance_port, startup_trace_message};

    #[test]
    #[cfg(feature = "desktop")]
    fn single_instance_port_is_stable() {
        assert_eq!(
            single_instance_port("com.mine.app"),
            single_instance_port("com.mine.app")
        );
        assert_ne!(
            single_instance_port("com.mine.app"),
            single_instance_port("com.mine.dev")
        );
    }

    #[test]
    #[cfg(feature = "desktop")]
    fn single_instance_port_stays_in_reserved_range() {
        let port = single_instance_port("com.mine.app");
        assert!((43000..44000).contains(&port));
    }

    #[test]
    #[cfg(feature = "desktop")]
    fn production_startup_trace_does_not_publish_vault_paths() {
        assert_eq!(
            startup_trace_message(
                "open_vault",
                "done path=/Users/example/private-vault indexed=10",
                false,
            ),
            "done"
        );
        assert_eq!(
            startup_trace_message("startup", "milestone=first_cards_painted", false),
            "milestone=first_cards_painted"
        );
    }
}
