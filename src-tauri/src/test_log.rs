//! What the code under test wrote to the log, for a test to read
//! (SPEC_DEEP_AUDIT.md, Н11: a failure reaches the log, not only standard
//! error). One logger serves the whole test process, installed by the first
//! test that asks for it; each capture sees only the records of its own
//! thread, so tests running side by side do not read each other's lines.

use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread::ThreadId;

struct Record {
    thread: ThreadId,
    level: log::Level,
    text: String,
}

struct CapturingLogger {
    records: Mutex<Vec<Record>>,
}

impl log::Log for CapturingLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Record {
                thread: std::thread::current().id(),
                level: record.level(),
                text: record.args().to_string(),
            });
    }

    fn flush(&self) {}
}

static LOGGER: OnceLock<&'static CapturingLogger> = OnceLock::new();

/// The log records of the calling thread from this moment on.
pub(crate) struct Capture {
    logger: &'static CapturingLogger,
    thread: ThreadId,
    from: usize,
}

/// Start reading the log of the calling thread.
pub(crate) fn capture() -> Capture {
    let logger = *LOGGER.get_or_init(|| {
        let logger: &'static CapturingLogger = Box::leak(Box::new(CapturingLogger {
            records: Mutex::new(Vec::new()),
        }));
        // Another logger already installed would leave the records empty,
        // and the test that reads them fails, as it should.
        if log::set_logger(logger).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
        logger
    });
    let from = logger
        .records
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .len();
    Capture {
        logger,
        thread: std::thread::current().id(),
        from,
    }
}

impl Capture {
    /// The warnings and errors the thread logged since the capture began.
    pub(crate) fn warnings(&self) -> Vec<String> {
        self.records(log::Level::Warn)
            .into_iter()
            .map(|(_, text)| text)
            .collect()
    }

    /// Every line the thread logged since the capture began, at info and
    /// above, with its level.
    pub(crate) fn lines(&self) -> Vec<(log::Level, String)> {
        self.records(log::Level::Info)
    }

    fn records(&self, least: log::Level) -> Vec<(log::Level, String)> {
        self.logger
            .records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .skip(self.from)
            .filter(|record| record.thread == self.thread && record.level <= least)
            .map(|record| (record.level, record.text.clone()))
            .collect()
    }
}
