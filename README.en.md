# DSH PSD Batch Studio

**[中文](README.md) | English**

> Open-sourced by the **VinkWork team** at **Genca** (缙嘉集团, 上海缙嘉科技有限公司).
> VinkWork's core product is [VinkClaw.com](https://vinkclaw.com).

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin for producing e-commerce
main images at scale: load a PSD/PSB template, mark the product slots, drop in a
batch of SKU cut-outs, fine-tune on a canvas, and export every image.

The same core is also a template parse-and-control engine for agents. It does
four things: inspect a template, apply explicit edits, render, and check. It is
available as five agent tools, the `psd-engine` CLI, and a Node API, with or
without Harness.

> **License:** modified Apache License 2.0 with additional conditions.
> Commercial use is allowed; operating a multi-tenant service or removing the
> branding requires a written license. See [LICENSE](LICENSE) and
> [LICENSING.md](LICENSING.md).

## Who it is for

E-commerce design and operations teams that already build main images as PSD
templates and need many variants without repeating the same Photoshop steps, and
agents that put image production into an automated flow. The PSD stays the
source of truth: product images, text layers and layer visibility are changed
within the template's own structure, and every other layer stays as it is.

It is **not** a Photoshop replacement: it does not retouch photos, manage a DAM,
or understand business rules. Reading requirements and deciding what each image
should say is up to the user or the agent; the engine carries it out and reports
what happened.

## Use cases

- **Campaign batches** — one template × hundreds of SKUs for 618, Double 11, Black
  Friday, or a store-wide sale; or one SKU set × several campaign templates. Switch
  the template and keep the SKU queue.
- **New product launches** — one template, many color / size / pack variants;
  re-fit each SKU in the same slots without opening Photoshop.
- **Multi-platform and multi-size sets** — square, portrait, or long-image
  templates for Tmall, JD, Douyin, Pinduoduo, or an internal catalog; switch
  templates without rebuilding the workflow.
- **Design-to-operations handoff** — designers publish the approved PSD and slot
  rules; operations, agencies, or store managers run the batch themselves.
- **Agent-driven production** — the agent turns requirements into a job spec,
  `psd_render` or `psd-engine render` produces the batch (copy, prices, badges,
  gift images per image), and the agent checks itself with the reported
  positions and `psd_view`. Good for nightly jobs, catalog integrations, or
  “produce these 200 images before tomorrow” requests. When only the product
  image changes, `psd_batch_render` is simpler.
- **Template governance** — keep copy, badges, price bars, and campaign props on
  separate layers, then toggle them per campaign while the product slot stays
  stable.

A typical run:

```text
templates/summer-main.psd + skus/0715/*.png
        ↓  product-slot replacement
out/0715-main/*.jpg  (+ optional ZIP)
```

## Features

- **Template workbench** — open a `.psd` / `.psb`, browse the layer tree, toggle
  layers, and see the composite on an interactive canvas.
- **Product slots** — auto-detects likely product layers by size, position,
  aspect ratio, and naming; mark or unmark slots manually. Stacked copies of the
  same product (the artwork plus a shadow/highlight copy) form one slot cluster
  and are hidden together.
- **Batch SKU fitting** — import many PNG/JPG/WebP cut-outs; each is trimmed to
  its visible alpha bounds and fitted into every slot with contain / height /
  width / cover, plus anchor and fill controls.
- **Canvas fine-tune** — drag the product, scale with corner handles, set
  offset/scale/rotation numerically, and copy one adjustment to the whole batch.
- **Export** — JPG or PNG at the template resolution, one file per SKU, packed
  into a ZIP when requested.
- **Text redraw** — rewrite a text layer with real fonts: per-run family, size
  and colour, shrink to a width, positioned on Photoshop's recorded baseline;
  `check` measures the redraw against the PSD pixels.
- **Job-spec rendering** — each image states which text to change, which layers
  to show or hide, what goes into the product slot and which extra images go
  into which box; each result reports where text and images actually landed,
  and one failing job does not stop the rest.
- **Agent tools and CLI** — `psd_inspect`, `psd_render`, `psd_view`,
  `psd_text_check`, `psd_batch_render`; the same functions are available from
  the `psd-engine` CLI and the Node API.
- **Local-first** — PSD parsing and compositing happen in the browser (or in the
  Host process for agent batches). No network calls, no telemetry, no upload.

## Requirements

- DeepSeek Harness with the plugin manager, dsh `0.2.0-rc.2` or later
  (`dsh.engines.dsh >= 0.2.0-rc.2`).
  - Verified end to end on the desktop app 0.2.0-rc.2 (bundled dsh 0.2.0-rc.2,
    pnpm 11.7.0) with 0.2.x: GitHub install, cold-start activation, the
    workbench panel, agent tool registration, and a real PSD batch. The tools
    added in 0.3.0 are checked for registration, parameters and results with
    the same `@deepseek-ai/dsh-tools` version.
  - dsh `0.2.1-rc.5` and `0.2.2-rc.1`: tool registration and schemas checked
    with the matching `@deepseek-ai/dsh-tools`. These releases provide the
    `workingDirectory` service, which the tools prefer for the session
    workspace; 0.2.0 has no such service, so they use the session's own
    working directory there.
  - Version 0.2.5's agent tools register on no dsh release
    ([#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)); do not
    use it.
- Node.js 20+ for building, the agent tools and the CLI.
- npm registry access on install: the agent tools and the CLI depend on
  `@napi-rs/canvas`, which ships platform-specific prebuilt binaries.
- No Photoshop installation is required.

## Install

### From npm (recommended)

```text
plugin_manager install_bundle, target = dsh-psd-batch-studio
```

Pin a version with `dsh-psd-batch-studio@<version>` if you need a stable snapshot.

### From the repository

```text
plugin_manager install_bundle, target = github:vinkwork/dsh-psd-batch-studio
```

pnpm pins a GitHub dependency to the commit it installed; reinstall to pick up
later changes. Append `#branch` or `#commit` to install a specific one.

If the plugin manager cannot resolve a GitHub spec, clone and install the local
directory instead:

```bash
git clone https://github.com/vinkwork/dsh-psd-batch-studio.git
cd dsh-psd-batch-studio
npm install
```

```text
plugin_manager install_bundle, target = /absolute/path/to/dsh-psd-batch-studio
```

After installation, refresh the Harness page. A **PSD Batch Studio** icon
appears in the sidebar, and the agent gains the five tools listed under Agent tools.

### CLI or Node API only (no Harness)

```bash
npm install dsh-psd-batch-studio      # in your project, then npx psd-engine …
# or from a clone: npm install, then node bin/psd-engine.mjs …
```

### Build artifacts

`client.js` and `server.js` are committed so an install does not need a build
step. After changing source, rebuild them:

```bash
npm install
npm run build
```

Run the tests:

```bash
npm test
```

`npm test` runs three suites: the self-contained smoke test (fixture PSDs in a
temp folder: compositing, slots, export), the Host contract test, and the CLI
test (JSON output, exit codes, output folders and file names). The contract test
registers every agent tool through dsh's own `@deepseek-ai/dsh-tools` checks,
pinned to 0.2.0-rc.2 (the desktop app's runtime): schemas must stay inside
dsh's supported subset, `output.render` must exist, real results must match
their output schema, and the workspace must resolve with and without the
`workingDirectory` service. Run it after touching tool parameters or results:
dsh rejects an unsupported schema at registration, which takes every tool down.

## Troubleshooting

**`ERR_PNPM_UNEXPECTED_STORE` on install.** A local environment issue, not the
plugin: the profile's `node_modules` was installed by a different pnpm major
(for example a terminal pnpm 10), while the desktop app uses its bundled pnpm 11
and the two stores cannot be mixed. Move
`~/.dsh/profiles/<profile>/node_modules` aside and reinstall from Harness. Do
not install into a profile directory with a terminal pnpm.

**The plugin installed, but the agent has no `psd_inspect` or the other tools.**
Make sure it is not version 0.2.5, whose tool schemas dsh rejects on every
release ([#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)), and
upgrade. Do not keep two copies of this plugin in one profile (an old local
install plus the GitHub one, say): they share the `psd-batch-studio` entry.

## Using the workbench

1. Open the **PSD Batch Studio** panel from the sidebar.
2. Load a `.psd` / `.psb` template. The studio lists its layers and marks the
   detected product slots with a dashed outline.
3. Confirm the slots in the layer tree: the target button toggles a slot, the eye
   button toggles whether the layer is composited. Use the search box for large
   templates.
4. Import SKU cut-outs. Select one in the queue to preview it in every slot.
5. Tune fit mode, anchor, fill, offset, scale, and rotation. **Apply to all**
   copies the current adjustment to every SKU.
6. Export the batch as JPG or PNG, with or without a ZIP.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `psd_inspect` | Template size, layer tree (id, name, full path, depth, visibility, bounds), auto-detected slots, and the fonts the template uses or lacks. Text layers also report their copy, per-run styles (family, weight, size, color) and `pxPerPt` (pt-to-pixel ratio). |
| `psd_batch_render` | Render many SKUs into one template and write JPG/PNG files (optionally a ZIP) inside the workspace. The `suppressed` result lists slot siblings hidden together with the slot. |
| `psd_render` | Render job specs: per job, which text layers to rewrite (copy, per-run font/size/colour, fit-to-width), which layers to show or hide, which product image goes into the slots, and extra images fitted into a layer's box or a rect. Reports where each text and image actually landed; a failing job does not stop the rest. |
| `psd_view` | Crop and zoom an image, optionally with a coordinate grid and labelled boxes, saved as PNG for close inspection. |
| `psd_text_check` | Re-draw text layers with their original copy and compare with the PSD pixels to flag size or position drift (usually a missing font). |

`psd_render` takes the job spec described under the engine section below.
Example `psd_batch_render` request:

```json
{
  "template": "templates/summer-main.psd",
  "skuDir": "skus/0715",
  "outDir": "out/0715-main",
  "format": "jpg",
  "fit": "contain",
  "anchor": "center",
  "adjustments": {
    "sku-001": { "dy": -14, "scale": 1.03 }
  },
  "zip": true
}
```

All tools resolve paths relative to the session working directory and refuse
paths outside it, including links that lead outside. `psd_batch_render` and
`psd_render` default to JPG at quality 92; without an explicit output folder,
every batch gets a new folder and never overwrites an earlier one.

Visible siblings inside a slot's group that overlap the slot by at least 25% are
hidden together with the slot (stale product art and misaligned shadow copies
are the usual offenders); otherwise the new SKU would stack on top of the old
product's pixels. Suppressed layers are reported in the `suppressed` result, and
decorations that intentionally sit on top of the product should live in another
group. Near-identical stacked copies (shadow/highlight) keep using the existing
slot-cluster logic, and the slot fit rect is never inflated by suppression.

## Parse-and-control engine (CLI / Node API)

A template parse-and-control engine for agents. It does four things: inspect a
template, apply explicit edits, render, and check. Run the CLI in a project
where this package is installed (see Install):

```bash
npx psd-engine inspect templates/x.psb --fonts fonts/   # layer tree, per-run styles, pxPerPt, missing fonts
npx psd-engine render  jobs.json                        # or `render -` to read stdin
npx psd-engine view    out/a.jpg --crop 0,1000,700,1280 --scale 2 --grid
npx psd-engine check   templates/x.psb --fonts fonts/   # text redraw drift
```

Everything prints JSON. `render` exits 0 when every job succeeded, 2 when some
failed, 1 on bad input. A job spec:

```json
{
  "template": "templates/x.psb",
  "fonts": ["fonts"],
  "outDir": "out/1111",
  "defaults": { "slots": ["main/product"], "hide": ["gifts/old-art"] },
  "jobs": [
    {
      "name": "sku-001",
      "product": "products/sku-001.png",
      "text": [
        { "layer": "e49", "value": "2nd for 0", "runs": [{ "len": 1, "color": "#cc3046" }] },
        { "layer": "price/value", "value": "29.9", "runs": [{ "len": 2, "size": 24.4 }, { "len": 2, "size": 11 }] },
        { "layer": "tagline", "value": "Long tagline copy", "fitWidth": 616 }
      ],
      "hide": ["badge"],
      "images": [{ "source": "gifts/puff.png", "layer": "gifts/box", "fit": "contain" }]
    }
  ]
}
```

- Address layers by the `id` or full `path` from `inspect`, or by a unique name; ambiguous names fail with the candidates.
- If a listed slot or any source file is missing, that job fails instead of rendering with the template's original art.
- `images[].layer` may be a layer or a group (a group uses the union of its layers); `rect` gives coordinates directly.
- The output file name is `name` with only path-unsafe characters replaced (dots such as `19.9` are kept); duplicates in a batch get `-2`, `-3`.
- `runs` restyle the copy from its first character in order; fields left out keep the template style. `size` is pt, `sizePx` is px.
- `defaults` is merged under every job: text by layer, `show`/`hide`/`images` appended, other fields replaced by the job.
- Each job result reports `text[].box` (ink after redraw) next to `original`, and `images[].box` next to `target`, so overflow and overlap can be checked from numbers before looking with `view`.

From Node: `import { inspect, render, view, checkText } from 'dsh-psd-batch-studio/engine'`, same parameters.

## How it works

- PSD/PSB parsing uses [`ag-psd`](https://github.com/Agamnentzar/ag-psd): layer
  canvases, bounds, opacity, blend modes, masks, clipping, and layer styles.
- The compositor maps Photoshop blend modes to Canvas 2D operations and supports
  layer masks (luminance → alpha), clipping chains, solid and gradient overlays,
  drop shadows, outer glows, and an approximate stroke.
- A template is split into background runs and product slots, so a SKU image
  lands between the layers below it and the decorations above it.
- Slot clusters hide stacked copies of the same product and draw the SKU once.
- Text redraw expands the PSD style runs per character, applies the requested
  overrides, lays the copy out with real fonts and swaps it in for the layer's
  raster, so masks, clipping and layer styles still apply.
- The browser and the Host renderer share `src/core/`; the Host swaps the canvas
  implementation for `@napi-rs/canvas`.

```text
src/
  core/        canvas factory, PSD parsing/compositing, text redraw, fitting, view, export
  client/      Harness Client UI (React)
  engine.js    host-agnostic engine: inspect / render / view / checkText
  tools.js     dsh tools psd_render, psd_view, psd_text_check
  server.js    Host entry: psd_inspect, psd_batch_render + engine tools
bin/
  psd-engine.mjs  CLI over src/engine.js
index.js       Host plugin entry (registers the tools)
client.js      built browser artifact
server.js      built Host artifact
```

## Compatibility and limits

- Text layers keep their rasterized PSD pixels unless a job rewrites them.
  Redraw needs the font files the template uses (a PSD stores only font
  names); a missing font falls back and is listed in `missingFonts`. Register
  font folders with `fonts`.
- The workbench panel (sidebar UI) cannot edit text; rewriting text, placing
  gift images and the like go through the agent tools or the CLI. The engine
  itself rewrites text, toggles layers, swaps products and places any image.
- Vertical text and text on a path are not specially supported; layer styles on
  text (stroke, shadow) use the compositor's approximations. Run `check` on a
  new template before a large batch.
- Bevel/emboss and inner-shadow layer styles are approximated or skipped;
  stroke/shadow/glow are approximations. The compositor is tuned for typical
  e-commerce main-image templates.
- One template is processed at a time. Multi-template × multi-SKU matrices are
  not built in; the SKU queue is kept when switching templates.
- Very large PSB files (hundreds of MB) need hundreds of MB of memory; prefer
  the desktop app or the Host batch path.
- The Host tools require `@napi-rs/canvas`; if the native package cannot load on
  a platform, the browser workbench still works but the agent tools do not.

## Project

- Maintained by the VinkWork team at Genca (缙嘉集团, 上海缙嘉科技有限公司).
- VinkWork's core product: <https://vinkclaw.com>
- Issues and feature requests: <https://github.com/vinkwork/dsh-psd-batch-studio/issues>
- Source: <https://github.com/vinkwork/dsh-psd-batch-studio>

## License

Copyright (c) 2026 上海缙嘉科技有限公司 (Genca). Open-sourced by the VinkWork team.

Released under a **modified Apache License 2.0** with additional conditions:

- commercial use is permitted, including internal enterprise use and use as a
  backend or application platform;
- a commercial license from 上海缙嘉科技有限公司 (Genca) is required to operate a
  multi-tenant service, or to remove/modify the copyright, project name, or
  attribution in the frontend;
- contributors agree that the producer may adjust the license and use
  contributions commercially.

The full terms are in [LICENSE](LICENSE); the unmodified Apache 2.0 text is in
[LICENSE-APACHE](LICENSE-APACHE). Versions up to v0.1.2 were released under the
PolyForm Noncommercial License 1.0.0; those releases remain under their original
terms. Third-party MIT notices are in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
