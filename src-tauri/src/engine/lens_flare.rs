//! v2-node-graph scaffolding (lens-flare path).
//!
//! Typed model + passthrough [`LensFlareProcessor`] for the deferred
//! native lens-flare GPU implementation. `process` currently returns the
//! input unchanged; the real shader lands in Phase 2.
//! See `docs/spec/lens-flare-node.md` and `docs/spec/v2-node-graph.md`.

use serde::{Deserialize, Serialize};

use super::animation::{AnimatedParameter, Rgba, Vec2};
use super::node::{FrameContext, FrameTextureHandle, NodeId, NodeProcessError, NodeProcessor};
use super::tracker::{SourceBinding, TrackerData};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    Add,
    Screen,
    Lighten,
    SoftAdd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextureGroup {
    Elements,
    Glass,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlareObjectKind {
    Glow,
    Halo,
    Ring,
    Streak,
    Ghost,
    Orb,
    Iris,
    Caustic,
    Smoke,
    Secondary,
    EdgeFlash,
    GlassOverlay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnimationModKind {
    Pulse,
    Drift,
    Flicker,
    Rotate,
    ScaleBreath,
    Parallax,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextureAssetRef {
    pub group: TextureGroup,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GlassOverlay {
    pub texture: TextureAssetRef,
    pub opacity: AnimatedParameter<f32>,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnimationMod {
    pub kind: AnimationModKind,
    pub amount: f32,
    pub speed: f32,
    pub phase: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlareObject {
    pub id: String,
    pub kind: FlareObjectKind,
    pub enabled: bool,
    pub blend_mode: BlendMode,
    pub opacity: AnimatedParameter<f32>,
    pub scale: AnimatedParameter<f32>,
    pub rotation_deg: AnimatedParameter<f32>,
    pub color: AnimatedParameter<Rgba>,
    pub axis_position: AnimatedParameter<f32>,
    pub depth_factor: AnimatedParameter<f32>,
    pub source_offset: AnimatedParameter<Vec2>,
    pub texture_ref: Option<TextureAssetRef>,
    pub animation_mods: Vec<AnimationMod>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlarePreset {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub global_intensity: f32,
    pub objects: Vec<FlareObject>,
    pub overlays: Vec<GlassOverlay>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LensFlareNode {
    pub node_id: NodeId,
    pub enabled: bool,
    pub preset: FlarePreset,
    pub source_binding: SourceBinding,
    pub composite_mode: BlendMode,
    pub mask_input: Option<String>,
    pub tracker_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LensFlareInputs {
    pub frame: FrameTextureHandle,
    pub mask: Option<FrameTextureHandle>,
    pub tracker: Option<TrackerData>,
    pub time_override_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSource {
    pub normalized_position: Vec2,
    pub confidence: f32,
}

pub struct LensFlareProcessor {
    pub config: LensFlareNode,
}

impl LensFlareProcessor {
    pub fn new(config: LensFlareNode) -> Self {
        Self { config }
    }

    pub fn load_preset_from_json(json: &str) -> Result<FlarePreset, serde_json::Error> {
        serde_json::from_str(json)
    }

    pub fn resolve_source(
        &self,
        _inputs: &LensFlareInputs,
        _ctx: &FrameContext,
    ) -> Option<ResolvedSource> {
        None
    }
}

impl NodeProcessor<LensFlareInputs, FrameTextureHandle> for LensFlareProcessor {
    fn kind(&self) -> &'static str {
        "lens_flare"
    }

    fn process(
        &mut self,
        input: LensFlareInputs,
        _ctx: &FrameContext,
    ) -> Result<FrameTextureHandle, NodeProcessError> {
        // MVP scaffold only. Real flare rendering should happen in a native Rust render path
        // backed by GPU resources, but until that lands the processor remains a typed passthrough.
        Ok(input.frame)
    }
}
