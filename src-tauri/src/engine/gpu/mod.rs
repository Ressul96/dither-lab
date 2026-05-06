use serde_json::Value;
use std::borrow::Cow;
use std::sync::mpsc;
use std::sync::Mutex;
use wgpu::util::DeviceExt;

use super::frame::FrameBuffer;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

#[derive(Default)]
pub struct GpuRenderState {
    renderer: Mutex<Option<GpuRenderer>>,
}

impl GpuRenderState {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn apply_threshold(
        &self,
        input: &FrameBuffer,
        params: &Value,
    ) -> Result<FrameBuffer, String> {
        let mut guard = self.renderer.lock().map_err(|error| error.to_string())?;
        if guard.is_none() {
            *guard = Some(GpuRenderer::new()?);
        }
        guard
            .as_mut()
            .ok_or_else(|| "GPU renderer failed to initialize".to_string())?
            .apply_threshold(input, params)
    }

    pub(crate) fn apply_pixelate(
        &self,
        input: &FrameBuffer,
        params: &Value,
    ) -> Result<FrameBuffer, String> {
        let mut guard = self.renderer.lock().map_err(|error| error.to_string())?;
        if guard.is_none() {
            *guard = Some(GpuRenderer::new()?);
        }
        guard
            .as_mut()
            .ok_or_else(|| "GPU renderer failed to initialize".to_string())?
            .apply_pixelate(input, params)
    }

    pub(crate) fn apply_posterize(
        &self,
        input: &FrameBuffer,
        params: &Value,
    ) -> Result<FrameBuffer, String> {
        let mut guard = self.renderer.lock().map_err(|error| error.to_string())?;
        if guard.is_none() {
            *guard = Some(GpuRenderer::new()?);
        }
        guard
            .as_mut()
            .ok_or_else(|| "GPU renderer failed to initialize".to_string())?
            .apply_posterize(input, params)
    }
}

struct GpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    effect_bind_group_layout: wgpu::BindGroupLayout,
    pixelate_pipeline: wgpu::RenderPipeline,
    posterize_pipeline: wgpu::RenderPipeline,
    threshold_pipeline: wgpu::RenderPipeline,
}

impl GpuRenderer {
    fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|error| format!("Failed to request GPU adapter: {error}"))?;

        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Dither Lab GPU device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
            ..Default::default()
        }))
        .map_err(|error| format!("Failed to request GPU device: {error}"))?;

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Dither Lab linear sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });

        let effect_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Effect bind group layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let pixelate_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Pixelate WGSL"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("shaders/pixelate.wgsl"))),
        });
        let posterize_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Posterize WGSL"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("shaders/posterize.wgsl"))),
        });
        let threshold_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Threshold WGSL"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("shaders/threshold.wgsl"))),
        });

        let effect_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Effect pipeline layout"),
                bind_group_layouts: &[Some(&effect_bind_group_layout)],
                immediate_size: 0,
            });

        let pixelate_pipeline = create_effect_pipeline(
            &device,
            &effect_pipeline_layout,
            &pixelate_shader,
            "Pixelate pipeline",
        );
        let posterize_pipeline = create_effect_pipeline(
            &device,
            &effect_pipeline_layout,
            &posterize_shader,
            "Posterize pipeline",
        );
        let threshold_pipeline = create_effect_pipeline(
            &device,
            &effect_pipeline_layout,
            &threshold_shader,
            "Threshold pipeline",
        );

        Ok(Self {
            device,
            queue,
            sampler,
            effect_bind_group_layout,
            pixelate_pipeline,
            posterize_pipeline,
            threshold_pipeline,
        })
    }

    fn apply_pixelate(&self, input: &FrameBuffer, params: &Value) -> Result<FrameBuffer, String> {
        self.render_fullscreen_effect(
            input,
            &pixelate_uniform_bytes(params),
            &self.pixelate_pipeline,
            "Pixelate",
        )
    }

    fn apply_posterize(&self, input: &FrameBuffer, params: &Value) -> Result<FrameBuffer, String> {
        self.render_fullscreen_effect(
            input,
            &posterize_uniform_bytes(params),
            &self.posterize_pipeline,
            "Posterize",
        )
    }

    fn apply_threshold(&self, input: &FrameBuffer, params: &Value) -> Result<FrameBuffer, String> {
        self.render_fullscreen_effect(
            input,
            &threshold_uniform_bytes(params),
            &self.threshold_pipeline,
            "Threshold",
        )
    }

    fn render_fullscreen_effect(
        &self,
        input: &FrameBuffer,
        uniform_bytes: &[u8],
        pipeline: &wgpu::RenderPipeline,
        label: &str,
    ) -> Result<FrameBuffer, String> {
        let width = input.width as u32;
        let height = input.height as u32;
        if width == 0 || height == 0 {
            return Err(format!("GPU {label} input has empty dimensions"));
        }

        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };

        let input_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Effect input texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &input_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &input.pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            size,
        );

        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Effect output texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let uniform_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Effect uniforms"),
                contents: uniform_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Effect bind group"),
            layout: &self.effect_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&input_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let row_bytes = width * 4;
        let padded_row_bytes = align_to(row_bytes, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let output_buffer_size = padded_row_bytes as u64 * height as u64;
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Effect readback buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Effect encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Effect render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &output_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row_bytes),
                    rows_per_image: Some(height),
                },
            },
            size,
        );

        let submission = self.queue.submit(Some(encoder.finish()));
        let buffer_slice = output_buffer.slice(..);
        let (tx, rx) = mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: None,
            })
            .map_err(|error| format!("GPU poll failed: {error}"))?;
        rx.recv()
            .map_err(|error| format!("GPU map callback failed: {error}"))?
            .map_err(|error| format!("GPU readback map failed: {error}"))?;

        let mapped = buffer_slice.get_mapped_range();
        let mut pixels = vec![0; input.pixels.len()];
        let row_bytes_usize = row_bytes as usize;
        let padded_row_bytes_usize = padded_row_bytes as usize;
        for y in 0..height as usize {
            let src_start = y * padded_row_bytes_usize;
            let dst_start = y * row_bytes_usize;
            pixels[dst_start..dst_start + row_bytes_usize]
                .copy_from_slice(&mapped[src_start..src_start + row_bytes_usize]);
        }
        drop(mapped);
        output_buffer.unmap();

        Ok(FrameBuffer {
            width: input.width,
            height: input.height,
            pixels,
        })
    }
}

fn create_effect_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    label: &str,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_main"),
            targets: &[Some(FORMAT.into())],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn pixelate_uniform_bytes(params: &Value) -> [u8; 32] {
    let size_x = param_f32(params, "size", 8.0).round().clamp(1.0, 256.0);
    let raw_y = param_f32(params, "sizeY", 0.0);
    let size_y = if raw_y > 0.0 {
        raw_y.round().clamp(1.0, 256.0)
    } else {
        size_x
    };
    let values = [
        size_x,
        size_y,
        if param_str(params, "shape", "square") == "circle" {
            1.0
        } else {
            0.0
        },
        clamp(param_f32(params, "smoothing", 0.0) / 100.0, 0.0, 1.0),
        clamp(param_f32(params, "opacity", 100.0) / 100.0, 0.0, 1.0),
        0.0,
        0.0,
        0.0,
    ];
    f32_uniform_bytes(values)
}

fn posterize_uniform_bytes(params: &Value) -> [u8; 32] {
    let steps_r = param_f32(params, "steps", 8.0).round().clamp(2.0, 64.0);
    let raw_g = param_f32(params, "stepsG", 0.0);
    let raw_b = param_f32(params, "stepsB", 0.0);
    let steps_g = if raw_g > 0.0 {
        raw_g.round().clamp(2.0, 64.0)
    } else {
        steps_r
    };
    let steps_b = if raw_b > 0.0 {
        raw_b.round().clamp(2.0, 64.0)
    } else {
        steps_r
    };
    let values = [
        steps_r,
        steps_g,
        steps_b,
        if param_str(params, "gamma", "linear") == "srgb" {
            1.0
        } else {
            0.0
        },
        if param_str(params, "lumaMode", "rgb") == "luma" {
            1.0
        } else {
            0.0
        },
        clamp(param_f32(params, "opacity", 100.0) / 100.0, 0.0, 1.0),
        0.0,
        0.0,
    ];
    f32_uniform_bytes(values)
}

fn threshold_uniform_bytes(params: &Value) -> [u8; 32] {
    let values = [
        clamp(param_f32(params, "threshold", 50.0) / 100.0, 0.0, 1.0),
        clamp(param_f32(params, "softness", 0.0) / 100.0, 0.0, 0.5),
        threshold_channel_index(param_str(params, "channel", "luma")),
        if param_str(params, "invert", "off") == "on" {
            1.0
        } else {
            0.0
        },
        if param_str(params, "mode", "bw") == "source" {
            1.0
        } else {
            0.0
        },
        clamp(param_f32(params, "opacity", 100.0) / 100.0, 0.0, 1.0),
        0.0,
        0.0,
    ];
    f32_uniform_bytes(values)
}

fn f32_uniform_bytes(values: [f32; 8]) -> [u8; 32] {
    let mut bytes = [0; 32];
    for (index, value) in values.iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_ne_bytes());
    }
    bytes
}

fn threshold_channel_index(value: &str) -> f32 {
    match value {
        "r" | "red" => 1.0,
        "g" | "green" => 2.0,
        "b" | "blue" => 3.0,
        "max" => 4.0,
        _ => 0.0,
    }
}

fn param_f32(params: &Value, key: &str, fallback: f32) -> f32 {
    params
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value as f32)
        .unwrap_or(fallback)
}

fn param_str<'a>(params: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

fn align_to(value: u32, alignment: u32) -> u32 {
    value.div_ceil(alignment) * alignment
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn threshold_gpu_produces_hard_luma_mask_when_adapter_is_available() {
        let state = GpuRenderState::new();
        let input = FrameBuffer {
            width: 2,
            height: 2,
            pixels: vec![
                0, 0, 0, 255, //
                255, 255, 255, 255, //
                255, 0, 0, 255, //
                0, 255, 0, 255,
            ],
        };
        let params = json!({
            "threshold": 50.0,
            "softness": 0.0,
            "channel": "luma",
            "invert": "off",
            "mode": "bw",
            "opacity": 100.0
        });

        let output = match state.apply_threshold(&input, &params) {
            Ok(output) => output,
            Err(error) if error.contains("GPU adapter") || error.contains("GPU device") => return,
            Err(error) => panic!("GPU threshold failed: {error}"),
        };

        assert_eq!(output.width, 2);
        assert_eq!(output.height, 2);
        assert_eq!(
            output.pixels,
            vec![
                0, 0, 0, 255, //
                255, 255, 255, 255, //
                0, 0, 0, 255, //
                255, 255, 255, 255,
            ]
        );
    }

    #[test]
    fn pixelate_gpu_collapses_square_cells_when_adapter_is_available() {
        let state = GpuRenderState::new();
        let input = FrameBuffer {
            width: 4,
            height: 2,
            pixels: vec![
                255, 0, 0, 255, //
                255, 0, 0, 255, //
                0, 0, 255, 255, //
                0, 0, 255, 255, //
                255, 0, 0, 255, //
                255, 0, 0, 255, //
                0, 0, 255, 255, //
                0, 0, 255, 255,
            ],
        };
        let params = json!({
            "size": 2.0,
            "sizeY": 2.0,
            "shape": "square",
            "smoothing": 0.0,
            "opacity": 100.0
        });

        let output = match state.apply_pixelate(&input, &params) {
            Ok(output) => output,
            Err(error) if error.contains("GPU adapter") || error.contains("GPU device") => return,
            Err(error) => panic!("GPU pixelate failed: {error}"),
        };

        assert_eq!(output.width, 4);
        assert_eq!(output.height, 2);
        assert_eq!(output.pixels, input.pixels);
    }

    #[test]
    fn posterize_gpu_quantizes_rgb_steps_when_adapter_is_available() {
        let state = GpuRenderState::new();
        let input = FrameBuffer {
            width: 3,
            height: 1,
            pixels: vec![
                0, 0, 0, 255, //
                128, 128, 128, 255, //
                255, 64, 192, 255,
            ],
        };
        let params = json!({
            "steps": 2.0,
            "stepsG": 2.0,
            "stepsB": 2.0,
            "gamma": "linear",
            "lumaMode": "rgb",
            "opacity": 100.0
        });

        let output = match state.apply_posterize(&input, &params) {
            Ok(output) => output,
            Err(error) if error.contains("GPU adapter") || error.contains("GPU device") => return,
            Err(error) => panic!("GPU posterize failed: {error}"),
        };

        assert_eq!(output.width, 3);
        assert_eq!(output.height, 1);
        assert_eq!(
            output.pixels,
            vec![
                0, 0, 0, 255, //
                255, 255, 255, 255, //
                255, 0, 255, 255,
            ]
        );
    }
}
