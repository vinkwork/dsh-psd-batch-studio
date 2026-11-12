/**
 * dsh tools over src/engine.js: psd_render (job specs), psd_view, psd_text_check.
 * Every path is relative to, and confined to, the session workspace.
 */
import { render, view, checkText } from './engine.js'

const BOUNDS = { type: 'array', items: { type: 'integer' } }
const STRINGS = { type: 'array', items: { type: 'string' } }

const TEXT_RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['len'],
  properties: {
    len: { type: 'integer', description: 'Characters in this run, counted from the end of the previous run.' },
    family: { type: 'string', description: 'Font family or PostScript name.' },
    weight: { type: 'number', description: 'Font weight, 100-900.' },
    size: { type: 'number', description: 'Font size in PSD points (see psd_inspect pxPerPt).' },
    sizePx: { type: 'number', description: 'Font size in canvas pixels; wins over `size`.' },
    color: { type: 'string', description: 'Fill colour as #rrggbb.' },
    tracking: { type: 'number', description: 'Letter spacing in 1/1000 em, as in Photoshop.' },
  },
}

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layer'],
  properties: {
    layer: { type: 'string', description: 'Text layer id (e12), leaf id (l3), full path or unique name.' },
    value: { type: 'string', description: 'New copy. Without `runs`, characters keep the original styles.' },
    runs: { type: 'array', items: TEXT_RUN_SCHEMA, description: 'Per-run styles over the new copy.' },
    font: { type: 'string', description: 'Font for every run.' },
    weight: { type: 'number' },
    size: { type: 'number', description: 'Size in pt for every run.' },
    sizePx: { type: 'number', description: 'Size in px for every run.' },
    color: { type: 'string', description: '#rrggbb for every run.' },
    tracking: { type: 'number' },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    leading: { type: 'number', description: 'Fixed line height in pt.' },
    dx: { type: 'number', description: 'Horizontal nudge in px.' },
    dy: { type: 'number', description: 'Vertical nudge in px.' },
    fitWidth: { type: 'number', description: 'Shrink glyphs evenly so the widest line fits this many px.' },
    minPx: { type: 'number', description: 'Smallest glyph size fitWidth may shrink to.' },
    maxPx: { type: 'number', description: 'Largest glyph size in px.' },
  },
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', description: 'Image path.' },
    name: { type: 'string' },
    layer: { type: 'string', description: 'Fit into this layer’s bounds.' },
    rect: { type: 'array', items: { type: 'number' }, description: 'Fit into [x0, y0, x1, y1] instead.' },
    x: { type: 'number', description: 'Left edge when there is no target box.' },
    y: { type: 'number', description: 'Top edge when there is no target box.' },
    fit: { type: 'string', enum: ['contain', 'cover', 'none'], description: 'Default contain when a box is given.' },
    upscale: { type: 'boolean', description: 'false: never enlarge past 100%.' },
    align: { type: 'string', description: 'center (default), or any of top/bottom/left/right, e.g. "bottom".' },
    dx: { type: 'number' },
    dy: { type: 'number' },
    scale: { type: 'number', description: 'Multiplier after fitting.' },
    rotation: { type: 'number', description: 'Degrees.' },
    opacity: { type: 'number' },
    blend: { type: 'string', description: 'Canvas blend mode, e.g. multiply.' },
    above: { type: 'boolean', description: 'false: draw under the product slot instead of on top. Default true.' },
  },
}

const JOB_PROPERTIES = {
  name: { type: 'string', description: 'Output file stem. Default job-<n>.' },
  text: { type: 'array', items: TEXT_SCHEMA },
  show: { ...STRINGS, description: 'Layers (id/path/name) to show.' },
  hide: { ...STRINGS, description: 'Layers (id/path/name) to hide.' },
  images: { type: 'array', items: IMAGE_SCHEMA },
  product: { type: 'string', description: 'Product cut-out drawn into the slot layers in place of their art.' },
  slots: { ...STRINGS, description: 'Slot layers for `product`. Default: psd_inspect suggestedSlots.' },
  fit: { type: 'string', enum: ['contain', 'height', 'width', 'cover'] },
  anchor: { type: 'string', enum: ['bottom', 'center', 'top'] },
  fill: { type: 'number', description: 'Scale after fitting the product, e.g. 0.9.' },
  adjust: {
    type: 'object',
    additionalProperties: false,
    properties: { dx: { type: 'number' }, dy: { type: 'number' }, scale: { type: 'number' }, rotation: { type: 'number' } },
  },
  background: { type: 'string', description: 'Canvas colour under the template.' },
}

const JOB_SCHEMA = { type: 'object', additionalProperties: false, properties: JOB_PROPERTIES }

const JOB_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'name', 'file', 'ok'],
  properties: {
    index: { type: 'integer' },
    name: { type: 'string' },
    file: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
    text: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['layer', 'ok'],
        properties: {
          layer: { type: 'string' },
          ok: { type: 'boolean' },
          error: { type: 'string' },
          warnings: STRINGS,
          original: BOUNDS,
          box: BOUNDS,
        },
      },
    },
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'scale'],
        properties: { name: { type: 'string' }, target: BOUNDS, box: BOUNDS, scale: { type: 'number' } },
      },
    },
    product: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'target', 'box'],
        properties: { slot: { type: 'string' }, target: BOUNDS, box: BOUNDS },
      },
    },
    suppressed: STRINGS,
    missingFonts: STRINGS,
    warnings: STRINGS,
  },
}

const FONT_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['registered', 'skipped'],
  properties: { registered: STRINGS, skipped: STRINGS },
}

/** Register psd_render / psd_view / psd_text_check; returns their disposers. */
export function registerEngineTools(ctx, resolveSessionCwd) {
  const workspace = async (exec, name) => {
    if (!exec.agent) throw new Error(`${name} requires an agent session`)
    return resolveSessionCwd(ctx, exec)
  }
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'psd_render',
      description:
        'Render a PSD/PSB template once per job. A job says exactly what to change: text layers (new copy, per-run font/size/colour, fit-to-width), layers to show or hide, a product cut-out for the slot layers, and extra images fitted into a layer’s box or a rect. `defaults` is merged under every job (text by layer). Returns, per job, the output file and where each rewritten text and placed image actually landed (`box` vs `original`/`target`), so you can check overflow before looking at the image. A failing job does not stop the others.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template', 'jobs'],
        properties: {
          template: { type: 'string', description: 'PSD or PSB path relative to the session working directory.' },
          jobs: { type: 'array', items: JOB_SCHEMA },
          defaults: { ...JOB_SCHEMA, description: 'Merged under every job.' },
          outDir: { type: 'string', description: 'Output folder. Default out/<template>-<time>.' },
          format: { type: 'string', enum: ['jpg', 'png', 'webp'] },
          quality: { type: 'integer', description: 'JPEG/WebP quality 1-100. Default 92.' },
          background: { type: 'string', description: 'Canvas colour. Default white for JPG, transparent otherwise.' },
          fonts: { ...STRINGS, description: 'Font files or folders to register first.' },
          strictFonts: { type: 'boolean', description: 'Fail a job whose rewritten text needs a missing font.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['template', 'width', 'height', 'outDir', 'count', 'failed', 'jobs'],
          properties: {
            template: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            outDir: { type: 'string' },
            count: { type: 'integer' },
            failed: { type: 'integer' },
            fonts: FONT_REPORT_SCHEMA,
            jobs: { type: 'array', items: JOB_RESULT_SCHEMA },
          },
        },
        render: (_args, value) => {
          const lines = [`Rendered ${value.count}/${value.jobs.length} into ${value.outDir}`]
          for (const job of value.jobs) {
            if (!job.ok) lines.push(`  ✗ ${job.name}: ${job.error}`)
            else if (job.missingFonts?.length || job.warnings?.length || job.text?.some((row) => !row.ok)) {
              const notes = [
                ...(job.text || []).filter((row) => !row.ok).map((row) => row.error),
                ...(job.warnings || []),
                ...(job.missingFonts?.length ? [`missing fonts: ${job.missingFonts.join(', ')}`] : []),
              ]
              lines.push(`  ! ${job.file}: ${notes.join('; ')}`)
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const cwd = await workspace(exec, 'psd_render')
        return render({ ...args, root: cwd, confine: true })
      },
      timeoutMs: 20 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_view',
      description:
        'Crop and zoom an image (a render or any PNG/JPG) and optionally draw a coordinate grid and labelled boxes, then save it as PNG for you to look at. Use it to check small details: clipped glyphs, overlaps, decimal sizes, edges of placed images.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['image'],
        properties: {
          image: { type: 'string', description: 'Image path relative to the session working directory.' },
          crop: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] in image pixels. Default whole image.' },
          scale: { type: 'number', description: 'Zoom factor. Default: fit about 1600px wide.' },
          grid: { type: 'boolean', description: 'Draw a coordinate grid.' },
          gridStep: { type: 'number', description: 'Grid step in image pixels (implies grid).' },
          rects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rect'],
              properties: {
                rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] in image pixels.' },
                label: { type: 'string' },
                color: { type: 'string' },
              },
            },
          },
          out: { type: 'string', description: 'Output PNG path. Default <image>.view.png next to the image.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'width', 'height', 'crop', 'scale', 'rects'],
          properties: {
            file: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            crop: BOUNDS,
            scale: { type: 'number' },
            rects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'rect'],
                properties: { label: { type: 'string' }, rect: { type: 'array', items: { type: 'number' } } },
              },
            },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `Saved ${value.file} (${value.width}×${value.height}, crop [${value.crop.join(',')}], ×${value.scale})` },
        ],
      },
      async execute(args, exec) {
        const cwd = await workspace(exec, 'psd_view')
        const { gridStep, grid, ...rest } = args
        return view({ ...rest, grid: gridStep > 0 ? gridStep : !!grid, root: cwd, confine: true })
      },
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_text_check',
      description:
        'Re-draw every text layer (or the listed ones) with its ORIGINAL copy through the same engine psd_render uses, and compare with Photoshop’s pixels. Rows with `drift: true` will not match the template when rewritten (wrong or missing font, size or baseline off); fix fonts or nudge with dx/dy/size before batch rendering.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: { type: 'string', description: 'PSD or PSB path relative to the session working directory.' },
          layers: { ...STRINGS, description: 'Limit to these layer ids, paths or names.' },
          fonts: { ...STRINGS, description: 'Font files or folders to register first.' },
          sizeTolerance: { type: 'number', description: 'Allowed width/height ratio error. Default 0.06.' },
          offsetTolerance: { type: 'number', description: 'Allowed centre offset in px. Default 4.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['template', 'rows', 'drifted'],
          properties: {
            template: { type: 'string' },
            fonts: FONT_REPORT_SCHEMA,
            drifted: { type: 'integer' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['layer', 'text', 'ok'],
                properties: {
                  layer: { type: 'string' },
                  text: { type: 'string' },
                  ok: { type: 'boolean' },
                  note: { type: 'string' },
                  drift: { type: 'boolean' },
                  orig: BOUNDS,
                  rendered: BOUNDS,
                  widthRatio: { type: 'number' },
                  heightRatio: { type: 'number' },
                  dx: { type: 'number' },
                  dy: { type: 'number' },
                  topGap: { type: 'number' },
                  bottomGap: { type: 'number' },
                  warnings: STRINGS,
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `${value.template}: ${value.rows.length} text layer(s), ${value.drifted} drifted`,
              ...value.rows
                .filter((row) => row.drift || !row.ok)
                .map((row) =>
                  row.ok
                    ? `  ${row.layer}: width ×${row.widthRatio}, height ×${row.heightRatio}, offset ${row.dx},${row.dy}`
                    : `  ${row.layer}: ${row.note}`,
                ),
            ].join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const cwd = await workspace(exec, 'psd_text_check')
        return checkText({ ...args, root: cwd, confine: true })
      },
      isConcurrencySafe: () => false,
    }),
  )

  return disposers
}
