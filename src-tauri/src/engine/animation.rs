//! v2-node-graph scaffolding.
//!
//! Typed DTOs for animatable parameters, keyframes, and bezier handles.
//! Currently unconsumed at runtime — Phase 2 of the native render rewrite
//! will replace the loosely-typed `serde_json::Value` params in
//! [`crate::engine::frame`] with these strongly-typed equivalents.
//! See `docs/spec/v2-node-graph.md` for the full target architecture.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineDomain {
    Normalized,
    Frames,
    Seconds,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct TimelinePosition {
    pub domain: TimelineDomain,
    pub value: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct BezierHandle {
    pub time_offset: f32,
    pub value_offset: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum KeyframeInterpolation {
    Linear,
    Hold,
    Bezier {
        in_handle: BezierHandle,
        out_handle: BezierHandle,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Keyframe<T> {
    pub at: TimelinePosition,
    pub value: T,
    pub interpolation: KeyframeInterpolation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyframeTrack<T> {
    pub domain: TimelineDomain,
    pub keyframes: Vec<Keyframe<T>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum AnimatedParameter<T> {
    Static(T),
    Track(KeyframeTrack<T>),
}
