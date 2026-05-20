//! v2-node-graph scaffolding.
//!
//! Typed tracker samples + source bindings for the deferred native tracker
//! pipeline. Currently unconsumed at runtime. See `docs/spec/v2-node-graph.md`.

use serde::{Deserialize, Serialize};

use super::animation::{AnimatedParameter, Vec2};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackerFallbackMode {
    HoldLastValid,
    UseManual,
    HideFlare,
    BlendToManual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackerSample {
    pub frame: u64,
    pub normalized_position: Vec2,
    pub confidence: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackerData {
    pub tracker_id: String,
    pub samples: Vec<TrackerSample>,
    pub fallback_mode: TrackerFallbackMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SourceBinding {
    Manual {
        position: AnimatedParameter<Vec2>,
    },
    Tracker {
        tracker_id: String,
        fallback_position: Option<AnimatedParameter<Vec2>>,
        fallback_mode: TrackerFallbackMode,
    },
    Hybrid {
        tracker_id: String,
        manual_position: AnimatedParameter<Vec2>,
        tracker_influence: AnimatedParameter<f32>,
        fallback_mode: TrackerFallbackMode,
    },
}
