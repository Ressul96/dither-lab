struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct PosterizeUniforms {
  steps_r: f32,
  steps_g: f32,
  steps_b: f32,
  gamma: f32,
  luma_mode: f32,
  opacity: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: PosterizeUniforms;

const LUMA_W: vec3<f32> = vec3<f32>(0.299, 0.587, 0.114);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(3.0, 1.0),
    vec2<f32>(-1.0, 1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 2.0),
    vec2<f32>(2.0, 0.0),
    vec2<f32>(0.0, 0.0),
  );

  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  output.uv = uvs[vertex_index];
  return output;
}

fn to_linear(color: vec3<f32>) -> vec3<f32> {
  return pow(color, vec3<f32>(2.2));
}

fn to_srgb(color: vec3<f32>) -> vec3<f32> {
  return pow(color, vec3<f32>(1.0 / 2.2));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(source_texture, source_sampler, input.uv).rgb;
  let work = select(src, to_linear(src), params.gamma > 0.5);
  var result: vec3<f32>;

  if (params.luma_mode > 0.5) {
    let luma = dot(work, LUMA_W);
    let steps = max(params.steps_r, 2.0);
    let level = steps - 1.0;
    let quantized_luma = floor(luma * level + 0.5) / level;
    let chroma = work - vec3<f32>(luma);
    result = vec3<f32>(quantized_luma) + chroma;
  } else {
    let levels = vec3<f32>(
      max(params.steps_r - 1.0, 1.0),
      max(params.steps_g - 1.0, 1.0),
      max(params.steps_b - 1.0, 1.0),
    );
    result = floor(clamp(work, vec3<f32>(0.0), vec3<f32>(1.0)) * levels + vec3<f32>(0.5)) / levels;
  }

  let final_color = select(result, to_srgb(clamp(result, vec3<f32>(0.0), vec3<f32>(1.0))), params.gamma > 0.5);
  let color = mix(src, clamp(final_color, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(params.opacity, 0.0, 1.0));
  return vec4<f32>(color, 1.0);
}
