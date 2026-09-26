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
