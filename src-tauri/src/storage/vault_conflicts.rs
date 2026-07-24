use anyhow::{Context, Result};
use rusqlite::{params, Connection};

#[derive(Debug, Clone)]
pub struct VaultConflict {
    pub base_slug: String,
    pub conflict_slug: String,
    pub detected_at: String,
}

pub fn record_vault_conflict(
    conn: &Connection,
    base_slug: &str,
    conflict_slug: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO vault_conflicts (base_slug, conflict_slug)
         VALUES (?1, ?2)",
        params![base_slug, conflict_slug],
    )
    .context("failed to record vault conflict")?;
    Ok(())
}

pub fn list_vault_conflicts(conn: &Connection) -> Result<Vec<VaultConflict>> {
    let mut stmt = conn.prepare(
        "SELECT base_slug, conflict_slug, detected_at
         FROM vault_conflicts
         ORDER BY detected_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(VaultConflict {
            base_slug: row.get(0)?,
            conflict_slug: row.get(1)?,
            detected_at: row.get(2)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to list vault conflicts")
}

pub fn vault_conflict_exists(
    conn: &Connection,
    base_slug: &str,
    conflict_slug: &str,
) -> Result<bool> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM vault_conflicts
             WHERE base_slug = ?1 AND conflict_slug = ?2",
            params![base_slug, conflict_slug],
            |row| row.get(0),
        )
        .context("failed to check vault conflict")?;
    Ok(count > 0)
}

pub fn clear_vault_conflict(conn: &Connection, base_slug: &str, conflict_slug: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_conflicts
         WHERE base_slug = ?1 AND conflict_slug = ?2",
        params![base_slug, conflict_slug],
    )
    .context("failed to clear vault conflict")?;
    Ok(())
}
