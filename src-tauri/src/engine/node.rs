//! v2-node-graph scaffolding.
//!
//! Trait and DTOs for the future node-processor abstraction. Will collapse
//! into a single `EngineError` enum alongside [`crate::engine::error`] once
//! Phase 2 lands. See `docs/spec/v2-node-graph.md`.

use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{Display, Formatter};

use super::animation::Vec2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct NodeId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SocketId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrameTextureHandle {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub pixel_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameContext {
    pub frame_index: u64,
    pub timeline_time_seconds: f64,
    pub timeline_fps: f32,
    pub viewport_size: Vec2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeProcessError {
    pub message: String,
}

impl NodeProcessError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for NodeProcessError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl Error for NodeProcessError {}

pub trait NodeProcessor<I, O> {
    fn kind(&self) -> &'static str;

    fn prepare(&mut self, _ctx: &FrameContext) -> Result<(), NodeProcessError> {
        Ok(())
    }

    fn process(&mut self, input: I, ctx: &FrameContext) -> Result<O, NodeProcessError>;
}
