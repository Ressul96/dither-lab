# V2 Node Graph Direction

## Goal

V2 shifts Dither Lab from a layer-first dither editor into a lightweight node-based compositor
for video, image sequences, and EXR sources.

This is not a Blender clone. The goal is a smaller, cleaner creative tool where the user builds
an image-processing graph visually, previews the result in real time, and exports what they see.

The existing transport workflow remains important:
- the bottom video player stays fixed
- source playback, trim, FPS, compare, and stage interactions remain first-class
- the graph becomes the primary processing model instead of a layer stack

## Product Direction

The app should feel like a node-based compositor with strong dither support, not like a filter app
and not like a traditional layer editor.

Core principles for V2:
- node graph is the source of truth for image processing
- preview and export must evaluate the same graph
- source playback remains separate from graph editing
- selected node parameters are edited in the inspector
- the graph must stay extensible for future effects, masks, and utility nodes
- the MVP graph should stay intentionally small before effect expansion

## Layout

The overall app layout changes as follows:

- top: desktop menubar
- center: split vertically into preview area on top and node editor on bottom
- bottom: player card remains fixed and keeps transport responsibility
- right panel: becomes the selected node inspector
- left panel: can hold source info, graph tools, add-node actions, presets, and project helpers

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Window  About                                           │
├──────────────────────┬──────────────────────────────────┬─────────────────┤
│ Source / Tools       │ Stage / Preview                 │ Node Inspector  │
│ Add Node             │                                  │ selected node   │
│ Presets              │                                  │ parameters      │
│ Project              │                                  │ sockets info    │
│                      ├──────────────────────────────────┤                 │
│                      │ Node Editor                      │                 │
│                      │ Source -> Viewer Output          │                 │
├──────────────────────┴──────────────────────────────────┴─────────────────┤
│ Fixed Player Card: scrub, play, step, trim, FPS, compare                 │
└────────────────────────────────────────────────────────────────────────────┘
```

## Node Workflow

The graph behaves like an image-processing pipeline:

- users add nodes
- users drag nodes in the node editor
- users connect outputs to inputs
- users select a node to edit its parameters in the inspector
- the preview updates from the active graph result
- export uses the same evaluated output path

V2 removes the current layer-first mental model from the core workflow.

Do not treat nodes as a UI wrapper around layers. Nodes are the actual processing model.

## Initial Graph

The first graph in V2 should stay deliberately minimal.

Initial boot graph:
- `Source`
- `Viewer Output`

Default connection:
- `Source.image -> Viewer Output.image`

Rules for the initial graph:
- when a source is loaded, the graph is created automatically if empty
- the preview stage shows the `Viewer Output` result
- export also uses the `Viewer Output` result in this initial state
- no extra processing nodes are required for the first working graph

This keeps the first node-based build simple: the app is already graph-driven even before dither
and effect nodes arrive.

## Planned Node Families

These nodes are part of the V2 direction, but they do not all need to ship in the first graph:

- `Source`
- `Viewer Output`
- `Dither`
- `Adjust`
- `Mix`
- `Blur`
- `Glow`
- `Distort`

Future expansion can add:
- `Mask`
- `Color Ramp`
- `Levels`
- `Curves`
- `Displacement`
- `Noise`
- `LUT`
- `Matte / Key`
- `Temporal Stabilize`
- `Cache`
- `Histogram / Analysis`

## Dither As A Node

Dither is no longer a global panel or a dedicated layer concept.

It becomes a normal processing node in the graph:
- selectable in the node editor
- editable from the inspector
- chainable with other effects
- branchable and mixable with other image paths

Typical future chain:

```text
Source -> Adjust -> Dither -> Viewer Output
```

Or with branching:

```text
Source -> Dither ----\
                      Mix -> Viewer Output
Source -> Blur ------/
```

Inspector controls for a selected `Dither` node can include:
- algorithm
- threshold
- invert
- scale
- highlights
- compression
- blur radius
- error strength
- serpentine
- seed lock
- seed
- palette
- temporal controls

Every other node follows the same inspector rule: click node, edit node-specific parameters in the
right panel.

## Inspector Rules

The right panel is no longer a tabbed layers and EXR utility area. It becomes a selected-node
inspector.

Inspector behavior:
- no selection: show graph-level help and source summary
- source node selected: show source metadata and interpretation controls
- viewer output selected: show viewer/output-related options
- effect node selected: show only that node's editable parameters
- inspector should show node name, node type, inputs, outputs, and editable properties

The inspector should feel stable and predictable. It should not try to show every control in the
app at once.

## Graph Rules

The graph should be a DAG.

DAG means:
- `Directed`: connections have direction, from output socket to input socket
- `Acyclic`: connections are not allowed to loop back into themselves
- `Graph`: the whole node network is a graph of connected operations

Valid:

```text
Source -> Dither -> Viewer Output
```

Also valid:

```text
Source -> Blur ----\
                    Mix -> Viewer Output
Source -> Dither --/
```

Invalid:

```text
Source -> Dither -> Blur
           ^          |
           |__________|
```

That invalid example creates a loop. The output of later work feeds back into earlier work forever.

Why V2 should start as a DAG:
- evaluation order stays simple
- caching is easier
- preview updates are predictable
- export parity is easier to guarantee
- most compositor MVP workflows do not need feedback loops

Feedback-style graphs can be explored later if there is a real product need, but they should not
be part of the first node architecture.

## Rendering Model

The graph is evaluated per visible frame.

High-level flow:
1. Source provider resolves the current video frame or sequence frame.
2. The graph evaluator walks the nodes in dependency order.
3. Each node receives its input image buffer or texture.
4. The node applies its operation.
5. The node outputs a new image buffer or texture.
6. `Viewer Output` receives the final image for preview and export.

Implementation guidance:
- use topological ordering for graph evaluation
- support branch and merge patterns
- allow GPU-backed nodes for blur, glow, distort, and mix
- allow CPU-backed nodes where that is the right fit, including some dither algorithms
- keep preview and export on the same graph contract

## Caching And Dirty Propagation

To keep the app responsive:
- a node parameter change should dirty that node and downstream nodes only
- moving a node in the editor should not dirty image results
- playback should re-evaluate frame-dependent nodes each frame
- static graph sections may reuse cached buffers where safe
- zoom, pan, and inspector changes must not trigger unnecessary graph recomputation

## Save And Load

The graph must be serializable to a JSON-like project structure.

At minimum, project data should store:
- source references
- playback and trim state
- viewport state
- node list
- node positions
- node parameters
- connection list
- selected viewer/output target settings

Example shape:

```json
{
  "nodes": [
    { "id": "source-1", "type": "source", "x": 80, "y": 120, "params": {} },
    { "id": "viewer-output-1", "type": "viewer-output", "x": 420, "y": 120, "params": {} }
  ],
  "edges": [
    {
      "fromNode": "source-1",
      "fromSocket": "image",
      "toNode": "viewer-output-1",
      "toSocket": "image"
    }
  ]
}
```

## Export Contract

Export must read from the graph, not from old layer assumptions.

For the first graph:
- export reads from `Viewer Output`
- if the graph is only `Source -> Viewer Output`, export is effectively passthrough

Later, when effect nodes exist:
- export still reads from `Viewer Output`
- preview and export must match for the same frame and graph state

## Migration Notes From The Current App

The current app already has useful pieces that should remain:
- source loading
- hidden video element playback
- canvas stage
- transport controls
- trim
- FPS override
- compare modes
- zoom and pan
- pixel inspector
- undo and redo foundations

The main conceptual migration is:
- replace layer-first composition with graph-first composition
- replace right-side utility tabs with selected-node inspector
- move dither controls out of the global inspector and into a `Dither` node
- treat preview as the result of the `Viewer Output` node

## V2 Rollout

Recommended rollout order:

### Phase A - Node Shell Pivot

- split the center area into preview on top and node editor on bottom
- keep the fixed player card
- convert the right panel into a selected-node inspector shell
- add graph state, node model, edge model, and selection model
- auto-create `Source` and `Viewer Output`
- auto-connect `Source.image -> Viewer Output.image`

### Phase B - Graph-Driven Preview

- make preview read from the evaluated graph instead of direct layer assumptions
- keep the initial graph passthrough-only
- keep source playback, trim, FPS, compare, zoom, and pixel inspector working

### Phase C - First Processing Nodes

- add `Adjust`
- add `Dither`
- expose node parameters in the inspector
- support graph save/load

### Phase D - Core Compositor Nodes

- add `Mix`
- add `Blur`
- add `Glow`
- add `Distort`
- support branch and merge workflows

## Non-Goals For The First V2 Step

Do not block the node pivot on:
- masks
- displacement maps
- advanced multi-viewer routing
- feedback loops
- nested groups
- full Blender-style node parity
- dozens of node families on day one

The first success condition is simple:
- source loads
- source appears in a graph
- `Source` connects to `Viewer Output`
- preview is graph-driven
- the player still works
