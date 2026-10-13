//! Baseline save compatibility, independent of app versions and index schemas.

/// The B0 save protocol remains supported across ordinary component updates.
pub const BASE_SAVE_PROTOCOL: u32 = 1;
/// Capabilities needed to preserve save identity after a lost response.
pub const BASE_SAVE_CAPABILITIES: &[&str] = &["save_operation_v1", "operation_lookup_v1"];

/// Side effect free helper launch evidence, emitted before native messaging starts.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RuntimeProbe {
    /// Stable probe response format.
    pub schema_version: u32,
    /// Semantic helper version, checked against its package manifest.
    pub version: String,
    /// Compiled source identity, independent of semantic version ordering.
    pub build_id: String,
    /// Source commit provenance; a source archive can explicitly say unknown.
    pub commit: String,
    /// Save protocol generations the launched helper actually supports.
    pub save_protocols: Vec<u32>,
}

/// The file in the app's data folder where Mine records its build at every
/// launch (SPEC_DEEP_AUDIT.md, Е2.22): the CLI and the MCP server compare
/// their own build with it and say when they are from another one.
pub const APP_BUILD_FILE: &str = "app-build.json";

/// Which build a program of Mine is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BuildIdentity {
    /// The package version; it rarely changes between builds.
    pub version: String,
    /// The compiled source identity: what tells two builds apart.
    pub build_id: String,
    /// The source commit, or `source-archive`.
    pub commit: String,
}

impl BuildIdentity {
    /// The build of the running program.
    #[must_use]
    pub fn this_build() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            build_id: option_env!("MINE_BUILD_ID").unwrap_or("unidentified-build").to_owned(),
            commit: option_env!("MINE_BUILD_COMMIT").unwrap_or("unknown").to_owned(),
        }
    }

    /// The first twelve characters of the build id, enough to tell builds apart.
    #[must_use]
    pub fn short_id(&self) -> &str {
        self.build_id.get(..12).unwrap_or(&self.build_id)
    }

    /// `0.1.0+<short build id>`: the version as a person or a client shows it.
    #[must_use]
    pub fn label(&self) -> String {
        format!("{}+{}", self.version, self.short_id())
    }
}

/// Record the running build as the app's (called by the app at launch).
///
/// # Errors
/// The file cannot be written.
pub fn record_app_build(app_data_dir: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(app_data_dir)?;
    let bytes = serde_json::to_vec_pretty(&BuildIdentity::this_build()).map_err(std::io::Error::other)?;
    let mut temporary = tempfile::NamedTempFile::new_in(app_data_dir)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(app_data_dir.join(APP_BUILD_FILE)).map_err(|error| error.error)?;
    Ok(())
}

/// The build the app recorded at its last launch, if it did.
#[must_use]
pub fn recorded_app_build(app_data_dir: &std::path::Path) -> Option<BuildIdentity> {
    let bytes = std::fs::read(app_data_dir.join(APP_BUILD_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What a program of `own` build says when the app is another build: one
/// line for its user, or nothing when the builds match or the app recorded
/// none.
#[must_use]
pub fn build_mismatch_warning(own: &BuildIdentity, app: Option<&BuildIdentity>) -> Option<String> {
    let app = app?;
    (app.build_id != own.build_id).then(|| {
        format!(
            "warning: this mine CLI is build {} and the Mine app is build {}; reinstall the CLI from the app's build (bun run cli:install)",
            own.label(),
            app.label()
        )
    })
}

/// Compatibility failures are known before any source or journal write.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// No baseline protocol was requested.
    #[error("The requested save protocol is not supported")]
    UnsupportedProtocol,
    /// Required capability names were not represented as strings.
    #[error("required_capabilities must be a list of capability names")]
    InvalidCapabilities,
    /// An operation depends on a capability this executor cannot provide.
    #[error("The required save capability is not supported: {0}")]
    UnsupportedCapability(String),
}

/// Reject an explicitly incompatible operation before opening its journal.
/// Absent fields retain the existing baseline sender contract during transition.
pub fn validate_save_request(params: &serde_json::Value) -> Result<(), ProtocolError> {
    if let Some(protocol) = params.get("save_protocol") {
        if protocol.as_u64() != Some(u64::from(BASE_SAVE_PROTOCOL)) {
            return Err(ProtocolError::UnsupportedProtocol);
        }
    }
    if let Some(required) = params.get("required_capabilities") {
        let capabilities = required
            .as_array()
            .ok_or(ProtocolError::InvalidCapabilities)?;
        for capability in capabilities {
            let name = capability
                .as_str()
                .ok_or(ProtocolError::InvalidCapabilities)?;
            if !BASE_SAVE_CAPABILITIES.contains(&name) {
                return Err(ProtocolError::UnsupportedCapability(name.into()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_and_transition_senders_remain_compatible() {
        assert!(validate_save_request(&serde_json::json!({})).is_ok());
        assert!(validate_save_request(&serde_json::json!({
            "save_protocol": 1,
            "required_capabilities": ["save_operation_v1", "operation_lookup_v1"]
        }))
        .is_ok());
    }

    /// Е2.22: a program of another build than the app says so; the same
    /// build, or an app that recorded none, says nothing.
    #[test]
    fn a_build_other_than_the_apps_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let own = BuildIdentity::this_build();
        assert_eq!(recorded_app_build(dir.path()), None);
        assert_eq!(build_mismatch_warning(&own, None), None);
        record_app_build(dir.path()).unwrap();
        let app = recorded_app_build(dir.path()).unwrap();
        assert_eq!(app, own);
        assert_eq!(build_mismatch_warning(&own, Some(&app)), None);
        let older = BuildIdentity { build_id: "0123456789abcdef".into(), ..own.clone() };
        let warning = build_mismatch_warning(&own, Some(&older)).unwrap();
        let older_label = format!("{}+0123456789ab", own.version);
        assert!(warning.contains(&own.label()) && warning.contains(&older_label), "{warning}");
    }

    #[test]
    fn unknown_protocol_or_required_capability_is_rejected() {
        for request in [
            serde_json::json!({"save_protocol": 2}),
            serde_json::json!({"save_protocol": "1"}),
            serde_json::json!({"required_capabilities": ["future_save"]}),
            serde_json::json!({"required_capabilities": [null]}),
            serde_json::json!({"required_capabilities": "save_operation_v1"}),
        ] {
            assert!(validate_save_request(&request).is_err());
        }
    }
}
