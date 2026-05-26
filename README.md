# html-video

> **Open-source HTML→Video meta-layer.** Connect any local coding agent (Claude Code, Cursor, Codex, Gemini, OpenCode) and let it pick the right engine and template to render your idea into video.

## Why html-video

HTML→Video is a real category — but each existing engine is opinionated and limited:

- **[Hyperframes](https://github.com/heygen-com/hyperframes)** — HTML+GSAP first, agent-skill-driven, but locked to a single rendering paradigm
- **[Remotion](https://www.remotion.dev/)** — React-first, source-available (paid above 4 devs)
- **[Motion Canvas](https://github.com/motion-canvas/motion-canvas)** / **[Revideo](https://github.com/redotvideo/revideo)** — TypeScript generators on canvas, best for explainers
- **[Manim](https://github.com/3b1b/manim)** / **[DefinedMotion](https://github.com/HugoOlsson/DefinedMotion)** / others — math/3D-first, niche

Picking the right engine per use case, learning each authoring model, stitching them into one workflow — all takes engineering time. Most teams pick one and live with its tradeoffs.

**html-video** is the meta-layer:

- **Agent-native by default** — connect any local coding agent; the agent picks the right engine for the task
- **Multi-engine** — Hyperframes, Remotion, Motion Canvas, Revideo as pluggable backends; new engines drop in as adapters
- **Template marketplace** — curated, reusable patterns from across the ecosystem (data viz, product demos, social shorts, explainers, transitions)
- **Apache-2.0** — no per-render fees, no seat caps, no contributor agreements

## Status

**Pre-alpha — project scaffolded 2026-05-26.** No public code yet. Roadmap, design notes, and progress will land here as the architecture solidifies.

## Roadmap (high level)

1. Engine adapter spec (one interface, N backends)
2. Reference adapters: Hyperframes, Remotion, Motion Canvas
3. CLI / agent skill set (Claude Code, Cursor, Codex)
4. Template marketplace / registry
5. Local studio (preview + variant testing)

## License

[Apache-2.0](LICENSE)

## Maintained by

[nexu-io](https://github.com/nexu-io) — same team behind [Open Design](https://github.com/nexu-io/open-design).
