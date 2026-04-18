// Shared utilities used by both the Tauri app and the native messaging host.

#[cfg(feature = "desktop")]
use std::io::Write;
#[cfg(feature = "desktop")]
use std::path::PathBuf;
#[cfg(feature = "desktop")]
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    time::Duration,
};

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

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
    let now = std::time::SystemTime::now()
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
    app.path().app_data_dir().ok().map(|dir| dir.join("startup-trace.log"))
}

#[cfg(feature = "desktop")]
pub fn reset_startup_trace(app: &AppHandle) {
    let Some(path) = startup_trace_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, "");
}

#[cfg(feature = "desktop")]
pub fn append_startup_trace(app: &AppHandle, scope: &str, message: &str) {
    let Some(path) = startup_trace_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path) else { return };
    let _ = writeln!(file, "{} [{}] {}", now_iso8601(), scope, message);
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
    use super::single_instance_port;

    #[test]
    #[cfg(feature = "desktop")]
    fn single_instance_port_is_stable() {
        assert_eq!(single_instance_port("com.mine.app"), single_instance_port("com.mine.app"));
        assert_ne!(single_instance_port("com.mine.app"), single_instance_port("com.mine.dev"));
    }

    #[test]
    #[cfg(feature = "desktop")]
    fn single_instance_port_stays_in_reserved_range() {
        let port = single_instance_port("com.mine.app");
        assert!((43000..44000).contains(&port));
    }
}
