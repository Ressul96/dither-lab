struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct ThresholdUniforms {
  threshold: f32,
  softness: f32,
  channel: f32,
  invert: f32,
  mode: f32,
  opacity: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: ThresholdUniforms;

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

fn sample_channel(color: vec3<f32>, channel: f32) -> f32 {
  if (channel < 0.5) {
    return dot(color, LUMA_W);
  }
  if (channel < 1.5) {
    return color.r;
  }
  if (channel < 2.5) {
    return color.g;
  }
  if (channel < 3.5) {
    return color.b;
  }
  return max(max(color.r, color.g), color.b);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(source_texture, source_sampler, input.uv).rgb;
  let value = sample_channel(src, params.channel);
  let low = max(params.threshold - params.softness, 0.0);
  let high = params.threshold + params.softness + 0.001;
  var mask = smoothstep(low, high, value);
  if (params.invert > 0.5) {
    mask = 1.0 - mask;
  }

  var result: vec3<f32>;
  if (params.mode < 0.5) {
    result = vec3<f32>(mask);
  } else {
    result = src * mask;
  }

  let color = mix(src, clamp(result, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(params.opacity, 0.0, 1.0));
  return vec4<f32>(color, 1.0);
}
