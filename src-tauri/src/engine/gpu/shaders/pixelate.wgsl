struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct PixelateUniforms {
  size_x: f32,
  size_y: f32,
  shape: f32,
  smoothing: f32,
  opacity: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: PixelateUniforms;

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

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(source_texture, source_sampler, input.uv).rgb;
  let resolution = vec2<f32>(textureDimensions(source_texture));
  let cell_size = vec2<f32>(max(params.size_x, 1.0), max(params.size_y, 1.0));
  let pixel = input.uv * resolution;
  let cell = floor(pixel / cell_size);
  let cell_center = (cell + 0.5) * cell_size / resolution;
  var cell_color = textureSample(source_texture, source_sampler, cell_center).rgb;

  if (params.shape > 0.5) {
    let cell_local = (pixel - cell * cell_size) / cell_size - vec2<f32>(0.5);
    let dist = length(cell_local * 2.0);
    let aa = max(params.smoothing * 0.6 + 0.05, 0.05);
    let mask = 1.0 - smoothstep(1.0 - aa, 1.0, dist);
    cell_color = mix(vec3<f32>(0.0), cell_color, mask);
  } else if (params.smoothing > 0.001) {
    let cell_local = (pixel - cell * cell_size) / cell_size;
    let edge = min(cell_local, vec2<f32>(1.0) - cell_local);
    let min_edge = min(edge.x, edge.y);
    let aa = params.smoothing * 0.5 + 0.001;
    let mask = smoothstep(0.0, aa, min_edge);
    cell_color = mix(cell_color * 0.6, cell_color, mask);
  }

  let color = mix(src, clamp(cell_color, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(params.opacity, 0.0, 1.0));
  return vec4<f32>(color, 1.0);
}
