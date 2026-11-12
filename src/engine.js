/**
 * PSD parse-and-control engine for agents.
 *
 * Four stateless operations, no business vocabulary:
 *   inspect  — template → layer tree, text copy and per-run styles, bounds
 *   render   — template + job specs → images, with a per-job report
 *   view     — crop / zoom / annotate an image to look at details
 *   checkText — re-draw every text layer with its original copy and measure
 *               how far the engine lands from Photoshop's pixels
 *
 * Deciding WHAT goes into a job (which copy, which colour per run, which
 * layers to show, which image goes where) is the caller's job. The engine
 * only parses and executes.
 *
 * Every path is resolved against `root`. When `root` is set (the dsh host
 * passes the session workspace), paths may not leave it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { initializeCanvas } from 'ag-psd'
import { setCanvasFactory } from './core/canvas.js'
import {
  parseTemplate,
  buildScene,
  disposeScene,
  suggestSlots,
  isEntryVisible,
  findEntries,
  findLeaves,
  layerBounds,
} from './core/psd.js'
import { applyTextOverrides, cloneDoc, mergeOverrideLists, pxPerPtOf, fontFamilyOf, readFontPostScriptName } from './core/text.js'
import { drawScene, measureContent, productBox, DEFAULT_SETTINGS, DEFAULT_ADJUST } from './core/fit.js'
import { sanitizeName, uniqueName } from './core/export.js'
import { renderView } from './core/view.js'
import { calibrateText, inkBounds } from './core/calibrate.js'

setCanvasFactory((width, height) => createCanvas(width, height))
initializeCanvas((width, height) => createCanvas(width, height))

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'])
const FORMATS = new Set(['jpg', 'png', 'webp'])

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isInside(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve `candidate` against `root` (or the process cwd). With `confine`,
 * the path and its real path (symlinks followed) must stay inside `root`.
 */
export async function resolvePath(root, candidate, { mustExist = true, confine = false } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('A non-empty path is required')
  const base = root || process.cwd()
  const absolute = path.resolve(base, candidate)
  const realBase = confine ? await fs.realpath(base).catch(() => base) : base
  const inside = (target) => isInside(base, target) || isInside(realBase, target)
  if (confine && !inside(absolute)) throw new Error(`Path must stay inside the workspace: ${candidate}`)

  if (mustExist) {
    let real
    try {
      real = await fs.realpath(absolute)
    } catch {
      throw new Error(`Path does not exist: ${candidate}`)
    }
    if (confine && !inside(real)) throw new Error(`Path resolves outside the workspace: ${candidate}`)
    return real
  }
  if (confine) {
    // A write must not follow a symlink (or a linked ancestor) out of root.
    const link = await fs.lstat(absolute).catch(() => null)
    if (link) {
      const real = await fs.realpath(absolute).catch(() => null)
      if (!real || !inside(real)) throw new Error(`Path resolves outside the workspace: ${candidate}`)
    }
    let ancestor = path.dirname(absolute)
    for (;;) {
      const real = await fs.realpath(ancestor).catch(() => null)
      if (real) {
        if (!inside(real)) throw new Error(`Path resolves outside the workspace: ${candidate}`)
        break
      }
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  return absolute
}

// ---------------------------------------------------------------------------
// Templates and fonts
// ---------------------------------------------------------------------------

const templateCache = new Map()

export async function loadTemplate(absolutePath) {
  const stat = await fs.stat(absolutePath)
  const cached = templateCache.get(absolutePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.doc
  const buffer = await fs.readFile(absolutePath)
  const doc = await parseTemplate({
    name: path.basename(absolutePath),
    size: stat.size,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })
  if (templateCache.size >= 2) templateCache.delete(templateCache.keys().next().value)
  templateCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, doc })
  return doc
}

function hasFont(family) {
  if (!family) return true
  if (GlobalFonts.has(family)) return true
  const mapped = fontFamilyOf(family)
  return !!(mapped && GlobalFonts.has(mapped))
}

/**
 * Register font files (or folders of them) under every name a text layer may
 * ask for: the file stem, the PostScript name in the font (what PSD styles
 * carry) and the mapped system family.
 */
export async function registerFonts({ root, confine, fonts = [] }) {
  const files = []
  for (const item of [].concat(fonts || [])) {
    const absolute = await resolvePath(root, item, { confine })
    const stat = await fs.stat(absolute)
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolute, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile()) files.push(path.join(absolute, entry.name))
      }
    } else {
      files.push(absolute)
    }
  }
  const registered = []
  const skipped = []
  for (const full of files) {
    const extension = path.extname(full).toLowerCase()
    if (!FONT_EXTENSIONS.has(extension)) {
      if (!path.basename(full).startsWith('.')) skipped.push(path.basename(full))
      continue
    }
    const stem = path.basename(full, extension).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'font'
    const aliases = [stem]
    try {
      const postScript = readFontPostScriptName(await fs.readFile(full))
      if (postScript) aliases.push(postScript)
    } catch {
      /* unreadable name table: the file stem still works */
    }
    for (const alias of [...aliases]) {
      const mapped = fontFamilyOf(alias)
      if (mapped && !aliases.includes(mapped) && !GlobalFonts.has(mapped)) aliases.push(mapped)
    }
    let ok = false
    for (const alias of new Set(aliases)) {
      try {
        if (GlobalFonts.registerFromPath(full, alias) !== false) {
          registered.push(alias)
          ok = true
        }
      } catch {
        /* alias already taken by another face */
      }
    }
    if (!ok) skipped.push(path.basename(full))
  }
  return { registered: [...new Set(registered)], skipped }
}

function templateFamilies(doc) {
  const families = new Set()
  for (const entry of doc.entries) for (const run of entry.text?.runs || []) if (run.family) families.add(run.family)
  return families
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

const toBounds = (rect) => (rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.x + rect.w), Math.round(rect.y + rect.h)] : null)

const RUN_LIMIT = 64

/** A run with only the fields it has: no nulls, so strict schemas accept it. */
function cleanRun({ len, family, weight, size, color, tracking }) {
  const run = { len }
  if (family) run.family = family
  if (weight != null) run.weight = weight
  if (size != null) run.size = size
  if (Array.isArray(color)) run.color = color
  if (tracking != null) run.tracking = tracking
  return run
}

/**
 * Describe a template. Text layers carry their copy, per-run styles (size in
 * pt) and `pxPerPt`, so a caller can turn a pixel size into a run size.
 * Layers are addressed in other calls by `id`, `path` or (if unique) `name`.
 */
export async function inspect({ root, confine, template, fonts, limit = 600 }) {
  const absolute = await resolvePath(root, template, { confine })
  if (fonts) await registerFonts({ root, confine, fonts })
  const doc = await loadTemplate(absolute)
  const listed = doc.entries.filter((entry) => entry.kind === 'group' || entry.leafId)
  const layers = listed.slice(0, limit).map((entry) => {
    const layer = {
      id: entry.id,
      name: entry.name,
      path: entry.fullName || entry.name,
      kind: entry.kind,
      depth: entry.depth,
      visible: isEntryVisible(doc, entry.id),
    }
    if (entry.leafId) layer.leafId = entry.leafId
    if (entry.kind === 'text') layer.text = true
    if (entry.bounds) layer.bounds = entry.bounds
    if (entry.text) {
      const leaf = doc.leaves.find((item) => item.id === entry.leafId)
      const runs = entry.text.runs || []
      layer.textContent = entry.text.value
      layer.runCount = runs.length
      if (runs.length) {
        layer.runs = runs.slice(0, RUN_LIMIT).map(cleanRun)
        layer.runsTruncated = runs.length > RUN_LIMIT
      }
      if (entry.text.align) layer.align = entry.text.align
      layer.pxPerPt = Math.round(pxPerPtOf(entry.text, leaf ? leaf.height : 0) * 10000) / 10000
    }
    return layer
  })
  const families = [...templateFamilies(doc)].sort()
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    layers,
    truncated: listed.length > limit,
    suggestedSlots: suggestSlots(doc).map((id) => {
      const leaf = doc.leaves.find((item) => item.id === id)
      return { leafId: id, name: leaf.name, path: leaf.fullName || leaf.name, bounds: [leaf.left, leaf.top, leaf.left + leaf.width, leaf.top + leaf.height] }
    }),
    fonts: families,
    missingFonts: families.filter((family) => !hasFont(family)),
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function resolveSlotIds(doc, specs) {
  const ids = []
  for (const spec of specs) {
    const matches = findLeaves(doc, spec)
    if (!matches.length) throw new Error(`Slot layer not found: ${spec}`)
    if (matches.length > 1) {
      throw new Error(`Slot layer name is ambiguous (${matches.length} matches): ${spec}. Use the path or leafId: ${matches.map((leaf) => leaf.fullName || leaf.id).join(' | ')}`)
    }
    ids.push(matches[0].id)
  }
  return ids
}

function rectOf(doc, spec) {
  const raw = spec.rect
  if (Array.isArray(raw) && raw.length >= 4) {
    const [x0, y0, x1, y1] = raw.map(Number)
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
  }
  if (raw && raw.w != null) return { x: Number(raw.x) || 0, y: Number(raw.y) || 0, w: Number(raw.w), h: Number(raw.h) }
  if (spec.layer) {
    const box = layerBounds(doc, spec.layer)
    if (!box) throw new Error(`Image target layer not found: ${spec.layer}`)
    return box
  }
  return null
}

/**
 * Place one image. With a target box (`rect` or `layer`) and fit
 * contain/cover, its visible content is centred in the box; `align` pins it
 * to an edge instead. `dx`/`dy`/`scale`/`rotation` adjust after fitting.
 */
async function loadImageElement(root, confine, spec, doc) {
  const file = await resolvePath(root, spec.source, { confine })
  const image = await loadImage(file)
  const rotation = Number(spec.rotation) || 0
  const box = rectOf(doc, spec)
  const fit = spec.fit || (box ? 'contain' : 'none')
  const content = measureContent(image)
  let scale = 1
  let left = Number(spec.x) || 0
  let top = Number(spec.y) || 0
  if (box && fit !== 'none') {
    scale = fit === 'cover' ? Math.max(box.w / content.w, box.h / content.h) : Math.min(box.w / content.w, box.h / content.h)
    if (fit === 'contain' && spec.upscale === false) scale = Math.min(1, scale)
  }
  scale *= Number(spec.scale) > 0 ? Number(spec.scale) : 1
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  let canvas = createCanvas(width, height)
  canvas.getContext('2d').drawImage(image, 0, 0, width, height)
  if (box) {
    const cw = content.w * scale
    const ch = content.h * scale
    const align = String(spec.align || 'center')
    let cx = box.x + (box.w - cw) / 2
    let cy = box.y + (box.h - ch) / 2
    if (/left/.test(align)) cx = box.x
    if (/right/.test(align)) cx = box.x + box.w - cw
    if (/top/.test(align)) cy = box.y
    if (/bottom/.test(align)) cy = box.y + box.h - ch
    left = cx - content.x * scale
    top = cy - content.y * scale
  }
  if (rotation) {
    const radians = (rotation * Math.PI) / 180
    const cos = Math.abs(Math.cos(radians))
    const sin = Math.abs(Math.sin(radians))
    const turned = createCanvas(Math.ceil(width * cos + height * sin), Math.ceil(width * sin + height * cos))
    const ctx = turned.getContext('2d')
    ctx.translate(turned.width / 2, turned.height / 2)
    ctx.rotate(radians)
    ctx.drawImage(canvas, -width / 2, -height / 2)
    left -= (turned.width - width) / 2
    top -= (turned.height - height) / 2
    canvas = turned
  }
  left += Number(spec.dx) || 0
  top += Number(spec.dy) || 0
  const ink = inkBounds(canvas, 8)
  return {
    name: spec.name ? String(spec.name) : path.basename(file, path.extname(file)),
    canvas,
    left,
    top,
    opacity: spec.opacity == null ? 1 : Math.max(0, Math.min(1, Number(spec.opacity))),
    blend: spec.blend || 'normal',
    aboveSlots: spec.above !== false,
    report: {
      name: spec.name ? String(spec.name) : path.basename(file),
      ...(box ? { target: toBounds(box) } : {}),
      ...(ink ? { box: [Math.round(left + ink[0]), Math.round(top + ink[1]), Math.round(left + ink[2]), Math.round(top + ink[3])] } : {}),
      scale: Math.round(scale * 1000) / 1000,
    },
  }
}

function setVisibility(doc, specs, hidden, problems) {
  for (const spec of specs || []) {
    const matches = findEntries(doc, spec)
    if (!matches.length) {
      problems.push(`layer not found: ${spec}`)
      continue
    }
    for (const entry of matches) {
      if (hidden) doc.hidden.add(entry.id)
      else {
        // Showing a layer shows its ancestors too, otherwise it stays hidden.
        doc.hidden.delete(entry.id)
        for (const id of entry.path || []) doc.hidden.delete(id)
      }
    }
  }
}

/** Defaults merged under a job: text by layer, lists appended, scalars replaced. */
function mergeJob(defaults = {}, job = {}) {
  return {
    ...defaults,
    ...job,
    text: mergeOverrideLists(defaults.text, job.text) || [],
    show: [...(defaults.show || []), ...(job.show || [])],
    hide: [...(defaults.hide || []), ...(job.hide || [])],
    images: [...(defaults.images || []), ...(job.images || [])],
    product: job.product === undefined ? defaults.product : job.product,
    adjust: { ...(defaults.adjust || {}), ...(job.adjust || {}) },
  }
}

function encode(canvas, format, quality) {
  if (format === 'png') return canvas.toBuffer('image/png')
  return canvas.toBuffer(format === 'webp' ? 'image/webp' : 'image/jpeg', Math.round(quality))
}

/**
 * Render jobs against one template.
 *
 * job = {
 *   name,                       output file stem (default: job-<n>)
 *   text:   [{layer, value?, runs?, font?, size?, sizePx?, color?, ...}],
 *   show:   [layer], hide: [layer],
 *   product: image path,        drawn into `slots` (auto-detected if omitted)
 *   slots:  [layer], fit, anchor, fill, adjust: {dx, dy, scale, rotation},
 *   images: [{source, layer | rect, fit, align, dx, dy, scale, rotation, opacity, blend, above}],
 * }
 * `defaults` has the same shape and is merged under every job.
 *
 * One failing job never stops the others; each gets `ok` and `error`.
 */
export async function render({
  root,
  confine,
  template,
  jobs = [],
  defaults = {},
  outDir,
  format = 'jpg',
  quality = 92,
  background,
  fonts,
  strictFonts = false,
}) {
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('`jobs` must be a non-empty array')
  const fmt = String(format).toLowerCase() === 'jpeg' ? 'jpg' : String(format).toLowerCase()
  if (!FORMATS.has(fmt)) throw new Error(`Unsupported format: ${format}`)
  const absolute = await resolvePath(root, template, { confine })
  const fontReport = fonts ? await registerFonts({ root, confine, fonts }) : null
  const doc = await loadTemplate(absolute)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relativeOut = outDir || path.join('out', `${sanitizeName(doc.name.replace(/\.[^.]+$/, ''))}-${stamp}`)
  const absoluteOut = await resolvePath(root, relativeOut, { mustExist: false, confine })
  await fs.mkdir(absoluteOut, { recursive: true })

  const used = new Set()
  const results = []
  for (let index = 0; index < jobs.length; index += 1) {
    const job = mergeJob(defaults, jobs[index])
    const stem = sanitizeName(job.name != null && String(job.name).trim() ? String(job.name) : `job-${index + 1}`)
    const file = uniqueName(used, stem, fmt)
    const result = { index, name: String(job.name ?? stem), file, ok: false }
    results.push(result)
    let scene = null
    try {
      const clone = cloneDoc(doc)
      const problems = []
      setVisibility(clone, job.hide, true, problems)
      setVisibility(clone, job.show, false, problems)

      // Fonts this job will draw with: only layers it rewrites. Untouched
      // layers keep Photoshop's pixels and need no font.
      const families = new Set()
      for (const override of job.text) {
        const entry = findEntries(clone, String(override.layer ?? '')).find((item) => item.text)
        for (const run of entry?.text.runs || []) if (run.family) families.add(run.family)
        if (override.font) families.add(String(override.font))
        for (const run of override.runs || []) if (run.family) families.add(String(run.family))
      }
      const missing = [...families].filter((family) => !hasFont(family))
      if (strictFonts && missing.length) throw new Error(`Missing fonts: ${missing.join(', ')}`)

      const textReport = []
      if (job.text.length) {
        const applied = applyTextOverrides(clone, job.text, hasFont)
        for (const row of applied.results || []) {
          const entry = findEntries(clone, row.layer).find((item) => item.text && item.leafId)
          const leaf = entry && clone.leaves.find((item) => item.id === entry.leafId)
          const ink = row.ok && leaf ? inkBounds(leaf.canvas) : null
          textReport.push({
            layer: row.layer,
            ok: row.ok,
            ...(row.error ? { error: row.error } : {}),
            ...(row.warnings && row.warnings.length ? { warnings: row.warnings } : {}),
            ...(entry?.bounds ? { original: entry.bounds } : {}),
            ...(ink ? { box: [leaf.left + ink[0], leaf.top + ink[1], leaf.left + ink[2], leaf.top + ink[3]] } : {}),
          })
        }
      }

      clone.elements = []
      for (const spec of job.images) clone.elements.push(await loadImageElement(root, confine, spec, clone))

      let image = null
      let content = null
      const settings = {
        mode: job.fit || DEFAULT_SETTINGS.mode,
        anchor: job.anchor || DEFAULT_SETTINGS.anchor,
        fill: Number.isFinite(Number(job.fill)) ? Number(job.fill) : DEFAULT_SETTINGS.fill,
      }
      const adjust = { ...DEFAULT_ADJUST }
      for (const key of ['dx', 'dy', 'scale', 'rotation']) if (Number.isFinite(Number(job.adjust[key]))) adjust[key] = Number(job.adjust[key])
      if (job.product) {
        image = await loadImage(await resolvePath(root, job.product, { confine }))
        content = measureContent(image)
        const ids = job.slots && job.slots.length ? resolveSlotIds(clone, job.slots) : suggestSlots(clone)
        if (!ids.length) throw new Error('No product slot detected; pass `slots` (see inspect.suggestedSlots)')
        clone.slots = new Set(ids)
      } else {
        clone.slots = new Set()
      }

      scene = buildScene(clone)
      const canvas = createCanvas(doc.width, doc.height)
      const ctx = canvas.getContext('2d')
      // JPG has no alpha, so it gets white unless told otherwise; PNG/WebP stay transparent.
      const fill = job.background ?? background ?? (fmt === 'jpg' ? '#ffffff' : null)
      if (fill) {
        ctx.fillStyle = fill
        ctx.fillRect(0, 0, doc.width, doc.height)
      }
      drawScene(ctx, scene, image, content, settings, adjust)
      await fs.writeFile(path.join(absoluteOut, file), encode(canvas, fmt, quality))

      result.ok = true
      if (textReport.length) result.text = textReport
      if (clone.elements.length) result.images = clone.elements.map((element) => element.report)
      if (image) {
        result.product = scene.slots.map((slot) => ({
          slot: slot.name,
          target: toBounds(slot.rect),
          box: toBounds(productBox(slot.rect, image, content, settings, adjust)),
        }))
        if (scene.suppressed.length) result.suppressed = scene.suppressed.map((layer) => layer.name)
      }
      if (missing.length) result.missingFonts = missing
      if (problems.length) result.warnings = problems
    } catch (error) {
      result.error = String(error?.message || error)
    } finally {
      if (scene) disposeScene(scene)
    }
  }

  const failed = results.filter((item) => !item.ok)
  return {
    template: doc.name,
    width: doc.width,
    height: doc.height,
    outDir: path.relative(root || process.cwd(), absoluteOut) || '.',
    count: results.length - failed.length,
    failed: failed.length,
    ...(fontReport ? { fonts: fontReport } : {}),
    jobs: results,
  }
}

// ---------------------------------------------------------------------------
// view / checkText
// ---------------------------------------------------------------------------

/** Crop, zoom and annotate an image; writes a PNG and returns where it went. */
export async function view({ root, confine, image, out, crop, scale, rects, grid, maxWidth }) {
  const file = await resolvePath(root, image, { confine })
  const source = await loadImage(file)
  const result = renderView({ image: source, crop, scale, rects, grid, maxWidth })
  const target = out || path.join(path.dirname(path.relative(root || process.cwd(), file)), `${path.basename(file, path.extname(file))}.view.png`)
  const absoluteOut = await resolvePath(root, target, { mustExist: false, confine })
  await fs.mkdir(path.dirname(absoluteOut), { recursive: true })
  await fs.writeFile(absoluteOut, result.canvas.toBuffer('image/png'))
  return {
    file: path.relative(root || process.cwd(), absoluteOut),
    width: result.canvas.width,
    height: result.canvas.height,
    crop: toBounds(result.crop),
    scale: Math.round(result.scale * 1000) / 1000,
    rects: result.rects,
  }
}

/**
 * Re-draw text layers with their original copy and compare with the PSD
 * raster. `drift` marks rows whose size or position is off by more than the
 * tolerances; those layers will not match the template when rewritten.
 */
export async function checkText({ root, confine, template, layers, fonts, sizeTolerance = 0.06, offsetTolerance = 4 }) {
  const absolute = await resolvePath(root, template, { confine })
  const fontReport = fonts ? await registerFonts({ root, confine, fonts }) : null
  const doc = await loadTemplate(absolute)
  const clone = cloneDoc(doc)
  const rows = calibrateText(clone, hasFont, { layers }).map((row) => {
    if (!row.ok) return row
    const drift =
      Math.abs(row.widthRatio - 1) > sizeTolerance ||
      Math.abs(row.heightRatio - 1) > sizeTolerance ||
      Math.abs(row.dx) > offsetTolerance ||
      Math.abs(row.dy) > offsetTolerance
    return { ...row, drift }
  })
  return {
    template: doc.name,
    ...(fontReport ? { fonts: fontReport } : {}),
    rows,
    drifted: rows.filter((row) => row.drift).length,
  }
}
