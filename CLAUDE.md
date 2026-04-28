# DITHER LAB - AI Context

This file is intentionally short.

Use it for global context only. Detailed product and implementation specs live in `docs/spec/`.

## Project Snapshot

Dither Lab is a local-first Tauri desktop app for video, image-sequence, and EXR-sequence
dithering. The product should feel like a compact desktop editor, not a single-purpose filter UI.

Core promises:
- real-time preview
- shared workflow for video and numbered image sequences
- non-destructive trim and compare
- project save/load plus autosave recovery
- preview/export parity
- fully local processing

Target platforms:
- macOS
- Windows
- Linux

Language rules:
- App UI is English-only
- Code comments are English-only
- Commit messages are English-only

## Stack

- Tauri 2.x with Rust shell/backend pieces
- Vanilla HTML/CSS/JS frontend
- WebGL 2 for ordered or shader-friendly work
- Canvas 2D plus CPU for error diffusion
- FFmpeg sidecar for export

## Non-Negotiables

- No accounts, cloud sync, telemetry, or network-backed workflow
- No React, Vue, Svelte, or heavy frontend framework
- No JS build step unless it becomes genuinely necessary
- Do not split the product into separate video mode vs image mode
- Export must match preview behavior
- Hidden layers must not appear in export
- Seed-locked behavior must stay deterministic between preview and export

## Spec Map

Read only the docs relevant to the task instead of loading everything by default.

- [docs/spec/v2-node-graph.md](docs/spec/v2-node-graph.md)
  - v2 product direction, split preview/node layout, node workflow, graph rules, v2 rollout
- [docs/spec/product.md](docs/spec/product.md)
  - product scope, feature commitments, inputs, project files, deferred items
- [docs/spec/ui-and-ux.md](docs/spec/ui-and-ux.md)
  - layout, controls, stage interactions, presets UX, visual direction
- [docs/spec/algorithms-and-color.md](docs/spec/algorithms-and-color.md)
  - algorithm catalog, palette system, color rules
- [docs/spec/architecture.md](docs/spec/architecture.md)
  - tech stack, target file structure, render pipeline, state model, performance rules
- [docs/spec/export.md](docs/spec/export.md)
  - export modes, sequence export, current-frame export, parity requirements
- [docs/spec/implementation-plan.md](docs/spec/implementation-plan.md)
  - build phases, coding conventions, non-goals, references

## Read Path By Task

- For the node-graph v2 direction:
  - start with `docs/spec/v2-node-graph.md`
- For scaffolding or phase work:
  - start with `docs/spec/implementation-plan.md`
- For UI work:
  - read `docs/spec/ui-and-ux.md`
- For rendering, state, or performance work:
  - read `docs/spec/architecture.md`
- For dithering or palette work:
  - read `docs/spec/algorithms-and-color.md`
- For save/load, sources, autosave, or watch-folder behavior:
  - read `docs/spec/product.md`
  - then `docs/spec/architecture.md`
- For export work:
  - read `docs/spec/export.md`
  - then `docs/spec/architecture.md`

## Current Working Rule

If the repository is still mostly empty, treat the docs in `docs/spec/` as the source of truth for
what should be built.

Continue work in the current branch/worktree by default. Do not create a new branch or worktree
unless the user explicitly asks for one.
