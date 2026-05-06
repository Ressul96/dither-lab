use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use tauri::State;

use super::gpu::GpuRenderState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRenderRequest {
    pub width: u32,
    pub height: u32,
    pub nodes: Vec<NativeGraphNode>,
    pub edges: Vec<NativeGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGraphEdge {
    pub from_node: String,
    pub from_socket: String,
    pub to_node: String,
    pub to_socket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRenderResponse {
    pub viewer_output: NativeFrame,
    pub dither_output: Option<NativeFrame>,
}

#[derive(Debug, Clone)]
pub(crate) struct FrameBuffer {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) pixels: Vec<u8>,
}

#[tauri::command]
pub fn native_render_graph(
    request: NativeRenderRequest,
    pixels: Vec<u8>,
    gpu_state: State<'_, GpuRenderState>,
) -> Result<NativeRenderResponse, String> {
    render_graph(request, pixels, &gpu_state).map_err(|error| error.to_string())
}

fn render_graph(
    request: NativeRenderRequest,
    pixels: Vec<u8>,
    gpu_state: &GpuRenderState,
) -> Result<NativeRenderResponse, RenderError> {
    let source = FrameBuffer::new(request.width, request.height, pixels)?;
    let order = topological_sort(&request.nodes, &request.edges);
    let mut results: HashMap<String, FrameBuffer> = HashMap::new();

    for node_id in order {
        let Some(node) = request.nodes.iter().find(|item| item.id == node_id) else {
            continue;
        };
        let output = evaluate_node(node, &request.edges, &results, &source, gpu_state)?;
        if let Some(frame) = output {
            results.insert(node.id.clone(), frame);
        }
    }

    let viewer = request
        .nodes
        .iter()
        .find(|node| node.node_type == "viewer-output")
        .ok_or_else(|| RenderError::new("native graph has no viewer-output node"))?;
    let viewer_output = results
        .get(&viewer.id)
        .cloned()
        .ok_or_else(|| RenderError::new("native graph produced no viewer output"))?;

    Ok(NativeRenderResponse {
        viewer_output: viewer_output.into_native_frame(),
        dither_output: None,
    })
}

fn evaluate_node(
    node: &NativeGraphNode,
    edges: &[NativeGraphEdge],
    results: &HashMap<String, FrameBuffer>,
    source: &FrameBuffer,
    gpu_state: &GpuRenderState,
) -> Result<Option<FrameBuffer>, RenderError> {
    match node.node_type.as_str() {
        "source" => Ok(Some(source.clone())),
        "adjust" => Ok(resolve_input(node, "image", edges, results)
            .map(|input| apply_adjust(input, &node.params))),
        "posterize" => Ok(resolve_input(node, "image", edges, results).map(|input| {
            gpu_state
                .apply_posterize(input, &node.params)
                .unwrap_or_else(|_| apply_posterize(input, &node.params))
        })),
        "blur" => Ok(resolve_input(node, "image", edges, results)
            .map(|input| apply_blur(input, param_f64(&node.params, "radius", 0.0)))),
        "pixelate" => Ok(resolve_input(node, "image", edges, results).map(|input| {
            gpu_state
                .apply_pixelate(input, &node.params)
                .unwrap_or_else(|_| apply_pixelate(input, &node.params))
        })),
        "threshold" => Ok(resolve_input(node, "image", edges, results).map(|input| {
            gpu_state
                .apply_threshold(input, &node.params)
                .unwrap_or_else(|_| apply_threshold(input, &node.params))
        })),
        "glow" => Ok(resolve_input(node, "image", edges, results)
            .map(|input| apply_glow(input, &node.params))),
        "distort" => Ok(resolve_input(node, "image", edges, results)
            .map(|input| apply_distort(input, &node.params))),
        "mix" => Ok(apply_mix(
            resolve_input(node, "image_a", edges, results),
            resolve_input(node, "image_b", edges, results),
            &node.params,
        )),
        "viewer-output" => Ok(resolve_input(node, "image", edges, results).cloned()),
        other => Err(RenderError::new(format!(
            "native renderer does not support node type '{other}'"
        ))),
    }
}

fn resolve_input<'a>(
    node: &NativeGraphNode,
    socket: &str,
    edges: &[NativeGraphEdge],
    results: &'a HashMap<String, FrameBuffer>,
) -> Option<&'a FrameBuffer> {
    let edge = edges
        .iter()
        .find(|item| item.to_node == node.id && item.to_socket == socket)?;
    results.get(&edge.from_node)
}

fn topological_sort(nodes: &[NativeGraphNode], edges: &[NativeGraphEdge]) -> Vec<String> {
    let mut incoming: HashMap<String, usize> =
        nodes.iter().map(|node| (node.id.clone(), 0)).collect();
    let mut outgoing: HashMap<String, Vec<String>> = nodes
        .iter()
        .map(|node| (node.id.clone(), Vec::new()))
        .collect();

    for edge in edges {
        if incoming.contains_key(&edge.to_node) && outgoing.contains_key(&edge.from_node) {
            *incoming.entry(edge.to_node.clone()).or_insert(0) += 1;
            outgoing
                .entry(edge.from_node.clone())
                .or_default()
                .push(edge.to_node.clone());
        }
    }

    let mut queue: VecDeque<String> = nodes
        .iter()
        .filter(|node| incoming.get(&node.id).copied().unwrap_or(0) == 0)
        .map(|node| node.id.clone())
        .collect();
    let mut order = Vec::new();

    while let Some(node_id) = queue.pop_front() {
        order.push(node_id.clone());
        for next in outgoing.get(&node_id).into_iter().flatten() {
            let count = incoming.entry(next.clone()).or_insert(0);
            *count = count.saturating_sub(1);
            if *count == 0 {
                queue.push_back(next.clone());
            }
        }
    }

    order
}

fn apply_adjust(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let brightness = clamp(param_f64(params, "brightness", 0.0) / 100.0, -1.0, 1.0);
    let contrast = clamp(param_f64(params, "contrast", 100.0) / 100.0, 0.0, 2.0);
    let saturation = clamp(param_f64(params, "saturation", 100.0) / 100.0, 0.0, 2.0);
    let gamma = (param_f64(params, "gamma", 100.0) / 100.0).max(0.1);
    let exposure = clamp(param_f64(params, "exposure", 0.0) / 100.0, -4.0, 4.0);
    let exposure_multiplier = 2.0_f64.powf(exposure);
    let mut output = input.clone();

    for pixel in output.pixels.chunks_exact_mut(4) {
        let mut r = pixel[0] as f64 / 255.0;
        let mut g = pixel[1] as f64 / 255.0;
        let mut b = pixel[2] as f64 / 255.0;

        r = clamp01(r + brightness);
        g = clamp01(g + brightness);
        b = clamp01(b + brightness);

        r = clamp01((r - 0.5) * contrast + 0.5);
        g = clamp01((g - 0.5) * contrast + 0.5);
        b = clamp01((b - 0.5) * contrast + 0.5);

        let luma = luminance01(r, g, b);
        r = clamp01(luma + (r - luma) * saturation);
        g = clamp01(luma + (g - luma) * saturation);
        b = clamp01(luma + (b - luma) * saturation);

        r = clamp01(r.powf(1.0 / gamma) * exposure_multiplier);
        g = clamp01(g.powf(1.0 / gamma) * exposure_multiplier);
        b = clamp01(b.powf(1.0 / gamma) * exposure_multiplier);

        pixel[0] = to_u8(r * 255.0);
        pixel[1] = to_u8(g * 255.0);
        pixel[2] = to_u8(b * 255.0);
        pixel[3] = 255;
    }

    output
}

fn apply_posterize(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let steps_r = clamp(param_f64(params, "steps", 8.0).round(), 2.0, 64.0);
    let raw_g = param_f64(params, "stepsG", 0.0);
    let raw_b = param_f64(params, "stepsB", 0.0);
    let steps_g = if raw_g > 0.0 {
        clamp(raw_g.round(), 2.0, 64.0)
    } else {
        steps_r
    };
    let steps_b = if raw_b > 0.0 {
        clamp(raw_b.round(), 2.0, 64.0)
    } else {
        steps_r
    };
    let gamma = param_str(params, "gamma", "linear") == "srgb";
    let luma_mode = param_str(params, "lumaMode", "rgb") == "luma";
    let opacity = clamp(param_f64(params, "opacity", 100.0) / 100.0, 0.0, 1.0);
    if opacity <= 0.0 {
        return input.clone();
    }

    let level_r = steps_r - 1.0;
    let level_g = steps_g - 1.0;
    let level_b = steps_b - 1.0;
    let mut output = input.clone();
    for pixel in output.pixels.chunks_exact_mut(4) {
        let src_r = pixel[0] as f64 / 255.0;
        let src_g = pixel[1] as f64 / 255.0;
        let src_b = pixel[2] as f64 / 255.0;
        let work_r = if gamma { to_linear(src_r) } else { src_r };
        let work_g = if gamma { to_linear(src_g) } else { src_g };
        let work_b = if gamma { to_linear(src_b) } else { src_b };

        let (out_r, out_g, out_b) = if luma_mode {
            let luma = work_r * 0.299 + work_g * 0.587 + work_b * 0.114;
            let quantized_luma = (luma * level_r + 0.5).floor() / level_r;
            (
                quantized_luma + (work_r - luma),
                quantized_luma + (work_g - luma),
                quantized_luma + (work_b - luma),
            )
        } else {
            (
                (clamp01(work_r) * level_r + 0.5).floor() / level_r,
                (clamp01(work_g) * level_g + 0.5).floor() / level_g,
                (clamp01(work_b) * level_b + 0.5).floor() / level_b,
            )
        };

        let final_r = if gamma {
            to_srgb(clamp01(out_r))
        } else {
            clamp01(out_r)
        };
        let final_g = if gamma {
            to_srgb(clamp01(out_g))
        } else {
            clamp01(out_g)
        };
        let final_b = if gamma {
            to_srgb(clamp01(out_b))
        } else {
            clamp01(out_b)
        };
        pixel[0] = to_u8(mix(src_r * 255.0, final_r * 255.0, opacity));
        pixel[1] = to_u8(mix(src_g * 255.0, final_g * 255.0, opacity));
        pixel[2] = to_u8(mix(src_b * 255.0, final_b * 255.0, opacity));
        pixel[3] = 255;
    }

    output
}

fn apply_blur(input: &FrameBuffer, radius: f64) -> FrameBuffer {
    let radius = radius.round().max(0.0) as usize;
    if radius == 0 {
        return input.clone();
    }

    let first = box_blur(input, radius);
    box_blur(&first, radius)
}

fn apply_threshold(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let threshold = clamp(param_f64(params, "threshold", 50.0) / 100.0, 0.0, 1.0);
    let softness = clamp(param_f64(params, "softness", 0.0) / 100.0, 0.0, 0.5);
    let channel = param_str(params, "channel", "luma");
    let invert = param_str(params, "invert", "off") == "on";
    let source_mode = param_str(params, "mode", "bw") == "source";
    let opacity = clamp(param_f64(params, "opacity", 100.0) / 100.0, 0.0, 1.0);
    if opacity <= 0.0 {
        return input.clone();
    }

    let low = (threshold - softness).max(0.0);
    let high = threshold + softness + 0.001;
    let mut output = input.clone();

    for pixel in output.pixels.chunks_exact_mut(4) {
        let src_r = pixel[0] as f64;
        let src_g = pixel[1] as f64;
        let src_b = pixel[2] as f64;
        let value = threshold_channel_value(src_r / 255.0, src_g / 255.0, src_b / 255.0, channel);
        let mut mask = smoothstep(low, high, value);
        if invert {
            mask = 1.0 - mask;
        }

        let out_r = if source_mode {
            src_r * mask
        } else {
            mask * 255.0
        };
        let out_g = if source_mode {
            src_g * mask
        } else {
            mask * 255.0
        };
        let out_b = if source_mode {
            src_b * mask
        } else {
            mask * 255.0
        };
        pixel[0] = to_u8(mix(src_r, out_r, opacity));
        pixel[1] = to_u8(mix(src_g, out_g, opacity));
        pixel[2] = to_u8(mix(src_b, out_b, opacity));
        pixel[3] = 255;
    }

    output
}

fn apply_pixelate(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let size_x = clamp(param_f64(params, "size", 8.0).round(), 1.0, 256.0);
    let raw_y = param_f64(params, "sizeY", 0.0);
    let size_y = if raw_y > 0.0 {
        clamp(raw_y.round(), 1.0, 256.0)
    } else {
        size_x
    };
    if size_x <= 1.0 && size_y <= 1.0 {
        return input.clone();
    }

    let shape = param_str(params, "shape", "square");
    let smoothing = clamp(param_f64(params, "smoothing", 0.0) / 100.0, 0.0, 1.0);
    let opacity = clamp(param_f64(params, "opacity", 100.0) / 100.0, 0.0, 1.0);
    if opacity <= 0.0 {
        return input.clone();
    }

    let mut output = input.blank();
    let width = input.width as f64;
    let height = input.height as f64;

    for y in 0..input.height {
        for x in 0..input.width {
            let pixel_x = x as f64 + 0.5;
            let pixel_y = y as f64 + 0.5;
            let cell_x = (pixel_x / size_x).floor();
            let cell_y = (pixel_y / size_y).floor();
            let center_u = ((cell_x + 0.5) * size_x) / width;
            let center_v = ((cell_y + 0.5) * size_y) / height;
            let mut cell_color = sample_bilinear(input, center_u, center_v);

            let local_x = (pixel_x - cell_x * size_x) / size_x;
            let local_y = (pixel_y - cell_y * size_y) / size_y;
            if shape == "circle" {
                let dist = ((local_x - 0.5) * 2.0).hypot((local_y - 0.5) * 2.0);
                let aa = (smoothing * 0.6 + 0.05).max(0.05);
                let mask = 1.0 - smoothstep(1.0 - aa, 1.0, dist);
                cell_color[0] *= mask;
                cell_color[1] *= mask;
                cell_color[2] *= mask;
            } else if smoothing > 0.001 {
                let min_edge = local_x.min(1.0 - local_x).min(local_y).min(1.0 - local_y);
                let edge_mask = smoothstep(0.0, smoothing * 0.5 + 0.001, min_edge);
                let mask = 0.6 + edge_mask * 0.4;
                cell_color[0] *= mask;
                cell_color[1] *= mask;
                cell_color[2] *= mask;
            }

            let index = (y * input.width + x) * 4;
            output.pixels[index] = to_u8(mix(input.pixels[index] as f64, cell_color[0], opacity));
            output.pixels[index + 1] =
                to_u8(mix(input.pixels[index + 1] as f64, cell_color[1], opacity));
            output.pixels[index + 2] =
                to_u8(mix(input.pixels[index + 2] as f64, cell_color[2], opacity));
            output.pixels[index + 3] = 255;
        }
    }

    output
}

fn box_blur(input: &FrameBuffer, radius: usize) -> FrameBuffer {
    if radius == 0 {
        return input.clone();
    }

    let mut horizontal = input.blank();
    let mut output = input.blank();
    blur_horizontal(input, &mut horizontal, radius);
    blur_vertical(&horizontal, &mut output, radius);
    output
}

fn blur_horizontal(input: &FrameBuffer, output: &mut FrameBuffer, radius: usize) {
    let width = input.width;
    let mut prefix = vec![[0_u32; 4]; width + 1];

    for y in 0..input.height {
        prefix[0] = [0; 4];
        for x in 0..width {
            let src = (y * width + x) * 4;
            prefix[x + 1] = [
                prefix[x][0] + input.pixels[src] as u32,
                prefix[x][1] + input.pixels[src + 1] as u32,
                prefix[x][2] + input.pixels[src + 2] as u32,
                prefix[x][3] + input.pixels[src + 3] as u32,
            ];
        }

        for x in 0..width {
            let start = x.saturating_sub(radius);
            let end = (x + radius).min(width - 1) + 1;
            let count = (end - start) as u32;
            let dst = (y * width + x) * 4;
            output.pixels[dst] = ((prefix[end][0] - prefix[start][0]) / count) as u8;
            output.pixels[dst + 1] = ((prefix[end][1] - prefix[start][1]) / count) as u8;
            output.pixels[dst + 2] = ((prefix[end][2] - prefix[start][2]) / count) as u8;
            output.pixels[dst + 3] = ((prefix[end][3] - prefix[start][3]) / count) as u8;
        }
    }
}

fn blur_vertical(input: &FrameBuffer, output: &mut FrameBuffer, radius: usize) {
    let height = input.height;
    let mut prefix = vec![[0_u32; 4]; height + 1];

    for x in 0..input.width {
        prefix[0] = [0; 4];
        for y in 0..height {
            let src = (y * input.width + x) * 4;
            prefix[y + 1] = [
                prefix[y][0] + input.pixels[src] as u32,
                prefix[y][1] + input.pixels[src + 1] as u32,
                prefix[y][2] + input.pixels[src + 2] as u32,
                prefix[y][3] + input.pixels[src + 3] as u32,
            ];
        }

        for y in 0..height {
            let start = y.saturating_sub(radius);
            let end = (y + radius).min(height - 1) + 1;
            let count = (end - start) as u32;
            let dst = (y * input.width + x) * 4;
            output.pixels[dst] = ((prefix[end][0] - prefix[start][0]) / count) as u8;
            output.pixels[dst + 1] = ((prefix[end][1] - prefix[start][1]) / count) as u8;
            output.pixels[dst + 2] = ((prefix[end][2] - prefix[start][2]) / count) as u8;
            output.pixels[dst + 3] = ((prefix[end][3] - prefix[start][3]) / count) as u8;
        }
    }
}

fn apply_glow(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let threshold = clamp(param_f64(params, "threshold", 180.0), 0.0, 255.0);
    let radius = param_f64(params, "radius", 12.0).max(0.0);
    let strength = clamp(param_f64(params, "strength", 100.0) / 100.0, 0.0, 4.0);
    let mut bright = input.blank();

    for (src, dst) in input
        .pixels
        .chunks_exact(4)
        .zip(bright.pixels.chunks_exact_mut(4))
    {
        let luma = luminance8(src[0], src[1], src[2]);
        if luma >= threshold {
            let alpha = ((luma - threshold) / (255.0 - threshold).max(1.0)) * 255.0;
            dst[0] = src[0];
            dst[1] = src[1];
            dst[2] = src[2];
            dst[3] = to_u8(alpha);
        }
    }

    let blurred = apply_blur(&bright, radius);
    let mut output = input.clone();
    for (glow, dst) in blurred
        .pixels
        .chunks_exact(4)
        .zip(output.pixels.chunks_exact_mut(4))
    {
        let alpha = (glow[3] as f64 / 255.0) * strength;
        for channel in 0..3 {
            let base = dst[channel] as f64 / 255.0;
            let top = glow[channel] as f64 / 255.0;
            let screened = 1.0 - (1.0 - base) * (1.0 - top);
            dst[channel] = to_u8((base + (screened - base) * alpha) * 255.0);
        }
        dst[3] = 255;
    }

    output
}

fn apply_distort(input: &FrameBuffer, params: &Value) -> FrameBuffer {
    let amplitude = param_f64(params, "amplitude", 0.0).max(0.0);
    let frequency = param_f64(params, "frequency", 0.0).max(0.0);
    let phase = param_f64(params, "phase", 0.0);
    if amplitude == 0.0 || frequency == 0.0 {
        return input.clone();
    }

    let mut output = input.blank();
    let phase_rad = phase / 180.0 * std::f64::consts::PI;
    let cycles_per_height = frequency * std::f64::consts::PI * 2.0;
    for y in 0..input.height {
        let shift =
            ((y as f64 / input.height as f64) * cycles_per_height + phase_rad).sin() * amplitude;
        for x in 0..input.width {
            let src_x = (x as f64 - shift).round() as isize;
            if src_x < 0 || src_x >= input.width as isize {
                continue;
            }
            let src = (y * input.width + src_x as usize) * 4;
            let dst = (y * input.width + x) * 4;
            output.pixels[dst..dst + 4].copy_from_slice(&input.pixels[src..src + 4]);
        }
    }

    output
}

fn apply_mix(
    input_a: Option<&FrameBuffer>,
    input_b: Option<&FrameBuffer>,
    params: &Value,
) -> Option<FrameBuffer> {
    let primary = input_a.or(input_b)?;
    let factor = clamp(param_f64(params, "factor", 50.0) / 100.0, 0.0, 1.0);
    let mode = param_str(params, "mode", "normal");
    let mut output = primary.blank();

    if let Some(input) = input_a {
        output.copy_from(input);
    }

    let Some(input) = input_b else {
        return Some(output);
    };

    for (top, dst) in input
        .pixels
        .chunks_exact(4)
        .zip(output.pixels.chunks_exact_mut(4))
    {
        for channel in 0..3 {
            let base = dst[channel] as f64 / 255.0;
            let over = top[channel] as f64 / 255.0;
            let mixed = blend_channel(base, over, mode);
            dst[channel] = to_u8((base + (mixed - base) * factor) * 255.0);
        }
        dst[3] = 255;
    }

    Some(output)
}

fn blend_channel(base: f64, top: f64, mode: &str) -> f64 {
    match mode {
        "add" => clamp01(base + top),
        "multiply" => base * top,
        "screen" => 1.0 - (1.0 - base) * (1.0 - top),
        "overlay" => {
            if base < 0.5 {
                2.0 * base * top
            } else {
                1.0 - 2.0 * (1.0 - base) * (1.0 - top)
            }
        }
        "difference" => (base - top).abs(),
        _ => top,
    }
}

fn param_f64(params: &Value, key: &str, fallback: f64) -> f64 {
    params
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn param_str<'a>(params: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

fn luminance01(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

fn luminance8(r: u8, g: u8, b: u8) -> f64 {
    0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64
}

fn to_linear(value: f64) -> f64 {
    value.powf(2.2)
}

fn to_srgb(value: f64) -> f64 {
    value.powf(1.0 / 2.2)
}

fn threshold_channel_value(r: f64, g: f64, b: f64, channel: &str) -> f64 {
    match channel {
        "r" | "red" => r,
        "g" | "green" => g,
        "b" | "blue" => b,
        "max" => r.max(g).max(b),
        _ => 0.299 * r + 0.587 * g + 0.114 * b,
    }
}

fn smoothstep(edge0: f64, edge1: f64, value: f64) -> f64 {
    let t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mix(a: f64, b: f64, amount: f64) -> f64 {
    a * (1.0 - amount) + b * amount
}

fn sample_bilinear(input: &FrameBuffer, u: f64, v: f64) -> [f64; 3] {
    let x = clamp(u, 0.0, 1.0) * input.width as f64 - 0.5;
    let y = clamp(v, 0.0, 1.0) * input.height as f64 - 0.5;
    let x0 = clamp(x.floor(), 0.0, (input.width - 1) as f64) as usize;
    let y0 = clamp(y.floor(), 0.0, (input.height - 1) as f64) as usize;
    let x1 = (x0 + 1).min(input.width - 1);
    let y1 = (y0 + 1).min(input.height - 1);
    let tx = clamp(x - x.floor(), 0.0, 1.0);
    let ty = clamp(y - y.floor(), 0.0, 1.0);
    let top = mix_rgb(sample_rgb(input, x0, y0), sample_rgb(input, x1, y0), tx);
    let bottom = mix_rgb(sample_rgb(input, x0, y1), sample_rgb(input, x1, y1), tx);
    mix_rgb(top, bottom, ty)
}

fn sample_rgb(input: &FrameBuffer, x: usize, y: usize) -> [f64; 3] {
    let index = (y * input.width + x) * 4;
    [
        input.pixels[index] as f64,
        input.pixels[index + 1] as f64,
        input.pixels[index + 2] as f64,
    ]
}

fn mix_rgb(a: [f64; 3], b: [f64; 3], amount: f64) -> [f64; 3] {
    [
        mix(a[0], b[0], amount),
        mix(a[1], b[1], amount),
        mix(a[2], b[2], amount),
    ]
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn clamp01(value: f64) -> f64 {
    clamp(value, 0.0, 1.0)
}

fn to_u8(value: f64) -> u8 {
    clamp(value.round(), 0.0, 255.0) as u8
}

impl FrameBuffer {
    fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, RenderError> {
        let width = width as usize;
        let height = height as usize;
        let expected = width
            .checked_mul(height)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| RenderError::new("native frame dimensions overflow"))?;
        if pixels.len() != expected {
            return Err(RenderError::new(format!(
                "native frame expected {expected} RGBA bytes, got {}",
                pixels.len()
            )));
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    fn blank(&self) -> Self {
        Self {
            width: self.width,
            height: self.height,
            pixels: vec![0; self.pixels.len()],
        }
    }

    fn copy_from(&mut self, other: &FrameBuffer) {
        if self.width == other.width && self.height == other.height {
            self.pixels.copy_from_slice(&other.pixels);
        }
    }

    fn into_native_frame(self) -> NativeFrame {
        NativeFrame {
            width: self.width as u32,
            height: self.height as u32,
            pixels: self.pixels,
        }
    }
}

#[derive(Debug, Clone)]
struct RenderError {
    message: String,
}

impl RenderError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn render_graph_runs_native_supported_effect_chain() {
        let request = NativeRenderRequest {
            width: 2,
            height: 2,
            nodes: vec![
                node("source", "source", json!({})),
                node(
                    "pixelate",
                    "pixelate",
                    json!({
                        "size": 1.0,
                        "sizeY": 1.0,
                        "shape": "square",
                        "smoothing": 0.0,
                        "opacity": 100.0
                    }),
                ),
                node(
                    "posterize",
                    "posterize",
                    json!({
                        "steps": 2.0,
                        "stepsG": 2.0,
                        "stepsB": 2.0,
                        "gamma": "linear",
                        "lumaMode": "rgb",
                        "opacity": 0.0
                    }),
                ),
                node(
                    "threshold",
                    "threshold",
                    json!({
                        "threshold": 50.0,
                        "softness": 0.0,
                        "channel": "luma",
                        "invert": "off",
                        "mode": "bw",
                        "opacity": 100.0
                    }),
                ),
                node("viewer", "viewer-output", json!({})),
            ],
            edges: vec![
                edge("source", "image", "pixelate", "image"),
                edge("pixelate", "image", "posterize", "image"),
                edge("posterize", "image", "threshold", "image"),
                edge("threshold", "image", "viewer", "image"),
            ],
        };
        let pixels = vec![
            0, 0, 0, 255, //
            255, 255, 255, 255, //
            255, 0, 0, 255, //
            0, 255, 0, 255,
        ];

        let response = render_graph(request, pixels, &GpuRenderState::new()).unwrap();

        assert_eq!(response.viewer_output.width, 2);
        assert_eq!(response.viewer_output.height, 2);
        assert_eq!(
            response.viewer_output.pixels,
            vec![
                0, 0, 0, 255, //
                255, 255, 255, 255, //
                0, 0, 0, 255, //
                255, 255, 255, 255,
            ]
        );
    }

    fn node(id: &str, node_type: &str, params: Value) -> NativeGraphNode {
        NativeGraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            params,
        }
    }

    fn edge(from_node: &str, from_socket: &str, to_node: &str, to_socket: &str) -> NativeGraphEdge {
        NativeGraphEdge {
            from_node: from_node.to_string(),
            from_socket: from_socket.to_string(),
            to_node: to_node.to_string(),
            to_socket: to_socket.to_string(),
        }
    }
}
