use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub kind: EngineErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EngineErrorKind {
    Conflict,
    DuplicateNode,
    Gpu,
    GpuUnavailable,
    GraphCycle,
    InvalidInput,
    Io,
    LockPoisoned,
    NativeRender,
    NotFound,
    Process,
    UnsupportedNode,
}

impl EngineError {
    pub fn new(kind: EngineErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Conflict, message)
    }

    pub fn duplicate_node(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::DuplicateNode, message)
    }

    pub fn gpu(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Gpu, message)
    }

    pub fn gpu_unavailable(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::GpuUnavailable, message)
    }

    pub fn graph_cycle(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::GraphCycle, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::InvalidInput, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Io, message)
    }

    pub fn lock_poisoned(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::LockPoisoned, message)
    }

    pub fn native_render(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::NativeRender, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::NotFound, message)
    }

    pub fn process(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::Process, message)
    }

    pub fn unsupported_node(message: impl Into<String>) -> Self {
        Self::new(EngineErrorKind::UnsupportedNode, message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for EngineError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn engine_error_serializes_kind_and_message() {
        let error = EngineError::graph_cycle("native graph contains a cycle");

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "kind": "graph-cycle",
                "message": "native graph contains a cycle",
            })
        );
    }
}
