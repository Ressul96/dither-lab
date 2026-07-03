use exr::prelude::{read, FlatSamples, ReadChannels, ReadLayers};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::error::EngineError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExrFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub channels: Vec<String>,
    pub layers: Vec<NativeExrLayerInfo>,
    pub selected_pass: Option<NativeExrPassInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExrLayerInfo {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub channels: Vec<String>,
    pub passes: Vec<NativeExrPassInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeExrPassInfo {
    pub id: String,
    pub label: String,
    pub layer: String,
    pub red: Option<String>,
    pub green: Option<String>,
    pub blue: Option<String>,
    pub alpha: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExrChannelSelection {
    pub layer: Option<String>,
    pub red: Option<String>,
    pub green: Option<String>,
    pub blue: Option<String>,
    pub alpha: Option<String>,
    pub exposure: Option<f32>,
    pub whitepoint: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExrSequence {
    pub frames: Vec<String>,
    pub selected_index: usize,
    pub start_number: Option<u32>,
    pub padding: usize,
    pub pattern: Option<String>,
}

#[derive(Debug)]
struct ExrPixelBuffer {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
    tone_map: ExrToneMap,
}

impl ExrPixelBuffer {
    fn new(width: usize, height: usize, tone_map: ExrToneMap) -> Self {
        let byte_len = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .unwrap_or(0);
        Self {
            width,
            height,
            pixels: vec![0; byte_len],
            tone_map,
        }
    }

    fn set_pixel(&mut self, x: usize, y: usize, r: f32, g: f32, b: f32, a: f32) {
        if x >= self.width || y >= self.height {
            return;
        }
        let index = (y * self.width + x) * 4;
        if index + 3 >= self.pixels.len() {
            return;
        }
        self.pixels[index] = tone_map_sample(r, self.tone_map);
        self.pixels[index + 1] = tone_map_sample(g, self.tone_map);
        self.pixels[index + 2] = tone_map_sample(b, self.tone_map);
        self.pixels[index + 3] = alpha_sample(a);
    }
}

#[derive(Debug, Clone, Copy)]
struct ExrToneMap {
    exposure_scale: f64,
    whitepoint: f64,
}

impl Default for ExrToneMap {
    fn default() -> Self {
        Self {
            exposure_scale: 1.0,
            whitepoint: 4.0,
        }
    }
}

impl ExrToneMap {
    fn from_selection(selection: Option<&NativeExrChannelSelection>) -> Self {
        let Some(selection) = selection else {
            return Self::default();
        };
        let exposure_stops =
            f64::from(selection.exposure.unwrap_or(0.0).clamp(-400.0, 400.0)) / 100.0;
        let whitepoint =
            f64::from(selection.whitepoint.unwrap_or(400.0).clamp(10.0, 10_000.0)) / 100.0;
        Self {
            exposure_scale: 2.0_f64.powf(exposure_stops),
            whitepoint,
        }
    }
}

#[derive(Debug, Default)]
struct ChannelGroup {
    red: Option<String>,
    green: Option<String>,
    blue: Option<String>,
    alpha: Option<String>,
}

#[tauri::command]
pub fn decode_exr_frame(
    path: String,
    selection: Option<NativeExrChannelSelection>,
) -> Result<NativeExrFrame, EngineError> {
    if path.trim().is_empty() {
        return Err(EngineError::invalid_input("EXR path is empty"));
    }

    let image = read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .all_layers()
        .all_attributes()
        .from_file(&path)
        .map_err(|error| {
            EngineError::invalid_input(format!("failed to decode EXR frame '{path}': {error}"))
        })?;

    let tone_map = ExrToneMap::from_selection(selection.as_ref());
    let layers = exr_layer_info(&image)?;
    let selected_pass = resolve_exr_pass(&layers, selection.as_ref()).ok_or_else(|| {
        EngineError::invalid_input(format!(
            "EXR frame '{path}' does not contain readable channels"
        ))
    })?;
    let layer_index = selected_pass
        .layer
        .parse::<usize>()
        .map_err(|_| EngineError::invalid_input("EXR layer selection is invalid"))?;
    let layer = image
        .layer_data
        .get(layer_index)
        .ok_or_else(|| EngineError::invalid_input("EXR layer selection is out of range"))?;

    let mut pixels = ExrPixelBuffer::new(layer.size.width(), layer.size.height(), tone_map);
    let red = find_channel_samples(layer, selected_pass.red.as_deref());
    let green = find_channel_samples(layer, selected_pass.green.as_deref());
    let blue = find_channel_samples(layer, selected_pass.blue.as_deref());
    let alpha = find_channel_samples(layer, selected_pass.alpha.as_deref());

    if red.is_none() || green.is_none() || blue.is_none() {
        return Err(EngineError::invalid_input(
            "EXR channel selection is missing RGB data",
        ));
    }

    let expected_samples = layer
        .size
        .width()
        .checked_mul(layer.size.height())
        .ok_or_else(|| EngineError::invalid_input("EXR frame dimensions are too large"))?;
    for y in 0..layer.size.height() {
        for x in 0..layer.size.width() {
            let index = y * layer.size.width() + x;
            if index >= expected_samples {
                continue;
            }
            pixels.set_pixel(
                x,
                y,
                sample_at(red, index, 0.0),
                sample_at(green, index, 0.0),
                sample_at(blue, index, 0.0),
                sample_at(alpha, index, 1.0),
            );
        }
    }

    let expected_len = pixels
        .width
        .checked_mul(pixels.height)
        .and_then(|count| count.checked_mul(4))
        .ok_or_else(|| EngineError::invalid_input("EXR frame dimensions are too large"))?;

    if pixels.width == 0 || pixels.height == 0 || pixels.pixels.len() != expected_len {
        return Err(EngineError::invalid_input(
            "EXR frame decoded with invalid dimensions",
        ));
    }

    let width = u32::try_from(pixels.width)
        .map_err(|_| EngineError::invalid_input("EXR frame width is too large"))?;
    let height = u32::try_from(pixels.height)
        .map_err(|_| EngineError::invalid_input("EXR frame height is too large"))?;

    Ok(NativeExrFrame {
        width,
        height,
        pixels: pixels.pixels,
        channels: selected_pass
            .channels()
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        layers,
        selected_pass: Some(selected_pass),
    })
}

#[tauri::command]
pub fn detect_exr_sequence(path: String) -> Result<NativeExrSequence, EngineError> {
    if path.trim().is_empty() {
        return Err(EngineError::invalid_input("EXR path is empty"));
    }

    let selected = PathBuf::from(&path);
    let Some(file_name) = selected.file_name().and_then(|name| name.to_str()) else {
        return Ok(single_frame_sequence(path));
    };
    let Some(pattern) = NumberedExrPattern::from_file_name(file_name) else {
        return Ok(single_frame_sequence(path));
    };
    let Some(parent) = selected.parent() else {
        return Ok(single_frame_sequence(path));
    };

    let mut frames = Vec::new();
    let entries = std::fs::read_dir(parent).map_err(|error| {
        EngineError::io(format!(
            "failed to inspect EXR sequence folder '{}': {error}",
            parent.display()
        ))
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            EngineError::io(format!(
                "failed to inspect EXR sequence folder '{}': {error}",
                parent.display()
            ))
        })?;
        let entry_path = entry.path();
        let Some(name) = entry_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(number) = pattern.match_number(name) else {
            continue;
        };
        frames.push((number, entry_path));
    }

    if frames.is_empty() {
        return Ok(single_frame_sequence(path));
    }

    frames.sort_by_key(|(number, path)| (*number, path.clone()));
    let frame_paths: Vec<String> = frames
        .into_iter()
        .map(|(_, path)| path.to_string_lossy().into_owned())
        .collect();
    let selected_index = frame_paths
        .iter()
        .position(|item| Path::new(item) == selected.as_path())
        .unwrap_or(0);

    Ok(NativeExrSequence {
        frames: frame_paths,
        selected_index,
        start_number: pattern.number.parse::<u32>().ok(),
        padding: pattern.padding,
        pattern: Some(pattern.display_pattern()),
    })
}

fn tone_map_sample(value: f32, tone_map: ExrToneMap) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    let linear = f64::from(value.max(0.0)) * tone_map.exposure_scale;
    let whitepoint_sq = tone_map.whitepoint * tone_map.whitepoint;
    let mapped = (linear * (1.0 + linear / whitepoint_sq)) / (1.0 + linear);
    encode_srgb(mapped)
}

impl NativeExrPassInfo {
    fn channels(&self) -> Vec<&str> {
        [
            self.red.as_deref(),
            self.green.as_deref(),
            self.blue.as_deref(),
            self.alpha.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

fn exr_layer_info(image: &exr::prelude::FlatImage) -> Result<Vec<NativeExrLayerInfo>, EngineError> {
    image
        .layer_data
        .iter()
        .enumerate()
        .map(|(layer_index, layer)| {
            let channels: Vec<String> = layer
                .channel_data
                .list
                .iter()
                .map(|channel| channel.name.to_string())
                .collect();
            let width = u32::try_from(layer.size.width())
                .map_err(|_| EngineError::invalid_input("EXR layer width is too large"))?;
            let height = u32::try_from(layer.size.height())
                .map_err(|_| EngineError::invalid_input("EXR layer height is too large"))?;
            let label = layer
                .attributes
                .layer_name
                .as_ref()
                .map(ToString::to_string)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| {
                    if image.layer_data.len() > 1 {
                        format!("Layer {}", layer_index + 1)
                    } else {
                        "Main".into()
                    }
                });
            Ok(NativeExrLayerInfo {
                id: layer_index.to_string(),
                label,
                width,
                height,
                passes: infer_exr_passes(layer_index, &channels),
                channels,
            })
        })
        .collect()
}

fn infer_exr_passes(layer_index: usize, channels: &[String]) -> Vec<NativeExrPassInfo> {
    let mut groups: BTreeMap<String, ChannelGroup> = BTreeMap::new();
    let mut grayscale = Vec::new();

    for channel in channels {
        if let Some((group, component)) = split_exr_color_channel(channel) {
            let entry = groups.entry(group).or_default();
            match component {
                'R' => entry.red = Some(channel.clone()),
                'G' => entry.green = Some(channel.clone()),
                'B' => entry.blue = Some(channel.clone()),
                'A' => entry.alpha = Some(channel.clone()),
                _ => {}
            }
        } else {
            grayscale.push(channel.clone());
        }
    }

    let mut passes = Vec::new();
    for (group, group_channels) in groups {
        if let Some(fallback) = first_rgb_channel(&group_channels) {
            let label = if group.is_empty() {
                "RGBA".into()
            } else {
                group.clone()
            };
            passes.push(NativeExrPassInfo {
                id: format!(
                    "{}:{}",
                    layer_index,
                    if group.is_empty() { "rgba" } else { &group }
                ),
                label,
                layer: layer_index.to_string(),
                red: group_channels.red.or_else(|| Some(fallback.clone())),
                green: group_channels.green.or_else(|| Some(fallback.clone())),
                blue: group_channels.blue.or(Some(fallback)),
                alpha: group_channels.alpha,
            });
        }
    }

    for channel in grayscale {
        passes.push(NativeExrPassInfo {
            id: format!("{layer_index}:channel:{channel}"),
            label: channel.clone(),
            layer: layer_index.to_string(),
            red: Some(channel.clone()),
            green: Some(channel.clone()),
            blue: Some(channel),
            alpha: None,
        });
    }

    passes
}

fn resolve_exr_pass(
    layers: &[NativeExrLayerInfo],
    selection: Option<&NativeExrChannelSelection>,
) -> Option<NativeExrPassInfo> {
    if let Some(selection) = selection {
        if selection.red.is_some() || selection.green.is_some() || selection.blue.is_some() {
            let layer = selection
                .layer
                .as_deref()
                .and_then(|layer_id| layers.iter().find(|layer| layer.id == layer_id))
                .or_else(|| layers.first())?;
            let fallback = selection
                .red
                .clone()
                .or_else(|| selection.green.clone())
                .or_else(|| selection.blue.clone())?;
            return Some(NativeExrPassInfo {
                id: format!("{}:custom", layer.id),
                label: "Custom".into(),
                layer: layer.id.clone(),
                red: selection.red.clone().or_else(|| Some(fallback.clone())),
                green: selection.green.clone().or_else(|| Some(fallback.clone())),
                blue: selection.blue.clone().or(Some(fallback)),
                alpha: selection.alpha.clone(),
            });
        }
    }

    layers
        .iter()
        .flat_map(|layer| layer.passes.iter())
        .find(|pass| is_preferred_rgba_pass(pass))
        .cloned()
        .or_else(|| {
            layers
                .iter()
                .flat_map(|layer| layer.passes.iter())
                .find(|pass| pass.red.is_some() && pass.green.is_some() && pass.blue.is_some())
                .cloned()
        })
}

fn is_preferred_rgba_pass(pass: &NativeExrPassInfo) -> bool {
    matches!(
        (
            pass.red.as_deref(),
            pass.green.as_deref(),
            pass.blue.as_deref()
        ),
        (Some("R"), Some("G"), Some("B"))
    )
}

fn split_exr_color_channel(channel: &str) -> Option<(String, char)> {
    if channel.len() == 1 {
        let component = channel.chars().next()?.to_ascii_uppercase();
        if matches!(component, 'R' | 'G' | 'B' | 'A') {
            return Some(("".into(), component));
        }
    }

    let (group, component) = channel.rsplit_once('.')?;
    if component.len() != 1 {
        return None;
    }
    let component = component.chars().next()?.to_ascii_uppercase();
    if matches!(component, 'R' | 'G' | 'B' | 'A') {
        Some((group.to_string(), component))
    } else {
        None
    }
}

fn first_rgb_channel(group: &ChannelGroup) -> Option<String> {
    group
        .red
        .clone()
        .or_else(|| group.green.clone())
        .or_else(|| group.blue.clone())
}

fn find_channel_samples<'a>(
    layer: &'a exr::prelude::Layer<exr::prelude::AnyChannels<FlatSamples>>,
    channel_name: Option<&str>,
) -> Option<&'a FlatSamples> {
    let channel_name = channel_name?;
    layer
        .channel_data
        .list
        .iter()
        .find(|channel| channel.name.to_string() == channel_name)
        .map(|channel| &channel.sample_data)
}

fn sample_at(samples: Option<&FlatSamples>, index: usize, fallback: f32) -> f32 {
    samples
        .map(|samples| samples.value_by_flat_index(index).to_f32())
        .unwrap_or(fallback)
}

fn single_frame_sequence(path: String) -> NativeExrSequence {
    NativeExrSequence {
        frames: vec![path],
        selected_index: 0,
        start_number: None,
        padding: 0,
        pattern: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumberedExrPattern {
    prefix: String,
    number: String,
    extension: String,
    padding: usize,
}

impl NumberedExrPattern {
    fn from_file_name(file_name: &str) -> Option<Self> {
        let lower = file_name.to_ascii_lowercase();
        if !lower.ends_with(".exr") {
            return None;
        }

        let extension_start = file_name.len().checked_sub(4)?;
        let stem = &file_name[..extension_start];
        let digit_start = stem
            .char_indices()
            .rev()
            .find_map(|(index, ch)| (!ch.is_ascii_digit()).then_some(index + ch.len_utf8()))
            .unwrap_or(0);
        if digit_start >= stem.len() {
            return None;
        }

        let number = &stem[digit_start..];
        Some(Self {
            prefix: stem[..digit_start].to_string(),
            number: number.to_string(),
            extension: file_name[extension_start..].to_string(),
            padding: number.len(),
        })
    }

    fn match_number(&self, file_name: &str) -> Option<u32> {
        let candidate = Self::from_file_name(file_name)?;
        if candidate.prefix != self.prefix
            || candidate.padding != self.padding
            || !candidate.extension.eq_ignore_ascii_case(&self.extension)
        {
            return None;
        }
        candidate.number.parse::<u32>().ok()
    }

    fn display_pattern(&self) -> String {
        format!(
            "{}{}{}",
            self.prefix,
            "#".repeat(self.padding),
            self.extension
        )
    }
}

fn alpha_sample(value: f32) -> u8 {
    if !value.is_finite() {
        return 255;
    }
    (f64::from(value).clamp(0.0, 1.0) * 255.0).round() as u8
}

fn encode_srgb(linear: f64) -> u8 {
    let encoded = if linear <= 0.003_130_8 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };
    (encoded.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_map_keeps_invalid_and_negative_samples_black() {
        assert_eq!(tone_map_sample(f32::NAN, ExrToneMap::default()), 0);
        assert_eq!(tone_map_sample(-1.0, ExrToneMap::default()), 0);
    }

    #[test]
    fn tone_map_exposure_increases_midtones() {
        let base = tone_map_sample(0.25, ExrToneMap::default());
        let brighter = tone_map_sample(
            0.25,
            ExrToneMap {
                exposure_scale: 2.0,
                whitepoint: 4.0,
            },
        );

        assert!(brighter > base);
    }

    #[test]
    fn alpha_defaults_invalid_samples_to_opaque() {
        assert_eq!(alpha_sample(f32::NAN), 255);
        assert_eq!(alpha_sample(-1.0), 0);
        assert_eq!(alpha_sample(2.0), 255);
    }

    #[test]
    fn decode_exr_frame_reads_rgba_file() {
        let path = unique_temp_path("decode");
        exr::prelude::write_rgba_file(&path, 2, 1, |x, _y| {
            if x == 0 {
                (1.0_f32, 0.0_f32, 0.0_f32, 1.0_f32)
            } else {
                (0.0_f32, 1.0_f32, 0.0_f32, 0.5_f32)
            }
        })
        .unwrap();

        let frame = decode_exr_frame(path.to_string_lossy().into_owned(), None).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(frame.width, 2);
        assert_eq!(frame.height, 1);
        assert_eq!(frame.pixels.len(), 8);
        assert_eq!(frame.layers.len(), 1);
        assert!(frame.layers[0]
            .passes
            .iter()
            .any(|pass| pass.label == "RGBA"));
        assert!(frame.pixels[0] > 0);
        assert_eq!(frame.pixels[3], 255);
        assert_eq!(frame.pixels[7], 128);
    }

    #[test]
    fn decode_exr_frame_uses_selected_channels() {
        let path = unique_temp_path("selection");
        exr::prelude::write_rgba_file(&path, 1, 1, |_x, _y| (1.0_f32, 0.25_f32, 0.0_f32, 1.0_f32))
            .unwrap();

        let frame = decode_exr_frame(
            path.to_string_lossy().into_owned(),
            Some(NativeExrChannelSelection {
                layer: Some("0".into()),
                red: Some("G".into()),
                green: Some("G".into()),
                blue: Some("G".into()),
                alpha: Some("A".into()),
                exposure: None,
                whitepoint: None,
            }),
        )
        .unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(frame.pixels[0], frame.pixels[1]);
        assert_eq!(frame.pixels[1], frame.pixels[2]);
        assert_eq!(frame.channels, vec!["G", "G", "G", "A"]);
    }

    #[test]
    fn infer_exr_passes_groups_rgb_suffixes_and_grayscale_channels() {
        let channels = vec![
            "R".to_string(),
            "G".to_string(),
            "B".to_string(),
            "diffuse.R".to_string(),
            "diffuse.G".to_string(),
            "diffuse.B".to_string(),
            "Z".to_string(),
        ];

        let passes = infer_exr_passes(0, &channels);

        assert!(passes.iter().any(|pass| pass.label == "RGBA"));
        assert!(passes.iter().any(|pass| pass.label == "diffuse"));
        let depth = passes.iter().find(|pass| pass.label == "Z").unwrap();
        assert_eq!(depth.red.as_deref(), Some("Z"));
        assert_eq!(depth.green.as_deref(), Some("Z"));
        assert_eq!(depth.blue.as_deref(), Some("Z"));
    }

    #[test]
    fn numbered_exr_pattern_matches_sibling_frames() {
        let pattern = NumberedExrPattern::from_file_name("shot_0007.exr").unwrap();

        assert_eq!(pattern.display_pattern(), "shot_####.exr");
        assert_eq!(pattern.match_number("shot_0008.exr"), Some(8));
        assert_eq!(pattern.match_number("shot_008.exr"), None);
        assert_eq!(pattern.match_number("other_0008.exr"), None);
        assert_eq!(pattern.match_number("shot_0008.png"), None);
    }

    #[test]
    fn detect_exr_sequence_sorts_matching_frames() {
        let dir = unique_temp_dir("sequence");
        std::fs::create_dir_all(&dir).unwrap();
        let frame_1 = dir.join("shot_0001.exr");
        let frame_2 = dir.join("shot_0002.exr");
        let frame_10 = dir.join("shot_0010.exr");
        let ignored = dir.join("shot_010.exr");
        for path in [&frame_10, &ignored, &frame_1, &frame_2] {
            std::fs::write(path, []).unwrap();
        }

        let sequence = detect_exr_sequence(frame_2.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_dir_all(dir);

        assert_eq!(sequence.frames.len(), 3);
        assert_eq!(sequence.selected_index, 1);
        assert_eq!(sequence.padding, 4);
        assert_eq!(sequence.pattern.as_deref(), Some("shot_####.exr"));
        assert!(sequence.frames[0].ends_with("shot_0001.exr"));
        assert!(sequence.frames[2].ends_with("shot_0010.exr"));
    }

    fn unique_temp_path(label: &str) -> PathBuf {
        unique_temp_dir(label).with_extension("exr")
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "dither-lab-exr-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
