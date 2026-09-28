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

/// When a card or collection was saved, as the person's wall clock showed it:
/// `YYYY-MM-DDTHH:MM:SS`, no time zone. Obsidian reads this form as a date,
/// while a `Z` suffix makes it a plain string (decision of the user,
/// 27.09.2026). Technical timestamps (logs, uploads) stay UTC via
/// [`now_iso8601`].
pub fn now_saved_at() -> String {
    local_timestamp(std::time::SystemTime::now())
}

/// Local wall-clock time without a zone, `YYYY-MM-DDTHH:MM:SS`.
pub fn local_timestamp(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let secs = i64::try_from(secs).unwrap_or(i64::MAX);
    let local = secs + local_offset_seconds(secs);
    let local = u64::try_from(local).unwrap_or(0);
    let (year, month, day) = days_to_ymd(local / 86_400);
    let rem = local % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The local zone's offset from UTC at that instant, in seconds (DST included).
#[cfg(unix)]
fn local_offset_seconds(epoch_secs: i64) -> i64 {
    let time: libc::time_t = epoch_secs as libc::time_t;
    // SAFETY: `localtime_r` only writes the provided `tm`, and is the
    // thread-safe form of `localtime`.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&time, &mut tm).is_null() {
            return 0;
        }
        i64::from(tm.tm_gmtoff as i32)
    }
}

#[cfg(not(unix))]
fn local_offset_seconds(_epoch_secs: i64) -> i64 {
    0
}

/// A stored `saved_at` in the local wall-clock form used for ordering.
///
/// Older files carry UTC (`…Z`) or an explicit offset; new files carry local
/// time without a zone. Sorting mixed strings would misplace cards saved around
/// the change, so the index keeps every value as local wall-clock time. The
/// files themselves are never rewritten for this. Date-only and zone-less
/// values are returned unchanged.
pub fn saved_at_local(value: &str) -> String {
    match iso8601_epoch_seconds(value) {
        Some(epoch) => local_timestamp(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::try_from(epoch).unwrap_or(0)),
        ),
        None => value.to_owned(),
    }
}

/// Seconds since the epoch for `YYYY-MM-DDTHH:MM:SSZ` or `…±HH:MM`; `None`
/// for any value without a zone, which is already local.
fn iso8601_epoch_seconds(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    let offset = match b.len() {
        20 if b[19] == b'Z' => 0,
        25 if b[19] == b'+' || b[19] == b'-' => {
            let hours: i64 = value.get(20..22)?.parse().ok()?;
            let minutes: i64 = value.get(23..25)?.parse().ok()?;
            let sign = if b[19] == b'-' { -1 } else { 1 };
            sign * (hours * 3600 + minutes * 60)
        }
        _ => return None,
    };
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    // Days from civil (Howard Hinnant), the inverse of `days_to_ymd`.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
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
    if scope == "process" && message == "started" {
        // Record the executable actually running, not merely the installed bundle.
        // JSON escaping keeps paths from injecting extra log records.
        let identity = process_identity();
        let _ = writeln!(
            file,
            "{} launch_id={} [process_identity] {}",
            now_iso8601(),
            launch_id(),
            identity
        );
    }
}

/// Local diagnostic identity for the process that is actually serving commands.
#[cfg(feature = "desktop")]
fn process_identity() -> serde_json::Value {
    serde_json::json!({
        "pid": std::process::id(),
        "executable": std::env::current_exe().ok(),
        "version": env!("CARGO_PKG_VERSION"),
        "build_id": env!("MINE_BUILD_ID"),
        "commit": env!("MINE_BUILD_COMMIT"),
        "schema_version": crate::storage::migrations::CURRENT_SCHEMA_VERSION,
        "index_generation": crate::domain::vault::INDEX_GENERATION,
    })
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
mod saved_at_tests {
    use super::*;

    #[test]
    fn saved_at_is_local_wall_clock_without_a_zone() {
        let value = now_saved_at();
        assert_eq!(value.len(), 19, "{value}");
        assert_eq!(&value[10..11], "T");
        assert!(!value.ends_with('Z'));
    }

    #[test]
    fn epoch_parsing_inverts_the_utc_formatter() {
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_790_558_711);
        let utc = system_time_to_iso8601(time);
        assert_eq!(iso8601_epoch_seconds(&utc), Some(1_790_558_711));
        assert_eq!(iso8601_epoch_seconds("2026-09-28T01:25:11Z"), iso8601_epoch_seconds("2026-09-27T22:25:11-03:00"));
        assert_eq!(iso8601_epoch_seconds("2026-09-27T22:25:11"), None);
        assert_eq!(iso8601_epoch_seconds("2026-09-27"), None);
    }

    #[test]
    fn stored_utc_becomes_the_same_instant_on_the_local_clock() {
        let instant = std::time::UNIX_EPOCH + std::time::Duration::from_secs(
            u64::try_from(iso8601_epoch_seconds("2026-09-28T01:25:11Z").unwrap()).unwrap(),
        );
        assert_eq!(saved_at_local("2026-09-28T01:25:11Z"), local_timestamp(instant));
        assert_eq!(saved_at_local("2026-09-27T22:25:11"), "2026-09-27T22:25:11");
        assert_eq!(saved_at_local("2026-09-27"), "2026-09-27");
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "desktop")]
    use super::{single_instance_port, startup_trace_message};

    #[test]
    #[cfg(feature = "desktop")]
    fn process_identity_reports_running_binary_and_compiled_source() {
        let identity = super::process_identity();
        assert_eq!(identity["pid"], std::process::id());
        assert_eq!(identity["index_generation"], crate::domain::vault::INDEX_GENERATION);
        assert_eq!(
            identity["schema_version"],
            crate::storage::migrations::CURRENT_SCHEMA_VERSION
        );
        let build = identity["build_id"]
            .as_str()
            .expect("build ID must be a string");
        assert_eq!(build.len(), 64);
        assert!(build.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(
            identity["executable"],
            serde_json::to_value(std::env::current_exe().expect("running test path"))
                .expect("serializable path")
        );
        assert!(!identity["commit"]
            .as_str()
            .expect("commit string")
            .is_empty());
    }

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
