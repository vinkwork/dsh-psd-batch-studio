/**
 * Host-side batch renderer and the agent tools built on it.
 *
 * The same compositor (`psd.js`, `fit.js`) that powers the browser workbench
 * runs here on a native canvas, so the agent can inspect a PSD template and
 * render a whole SKU folder without opening the page.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { initializeCanvas } from 'ag-psd'
import { zipSync } from 'fflate'
import { setCanvasFactory } from './core/canvas.js'
import { parseTemplate, buildScene, disposeScene, suggestSlots, isEntryVisible, isLeafVisible, findEntries, findLeaves, layerBounds, preferredSlotLeaves, anchorLeaves } from './core/psd.js'
import { planSheet, outputNameFor } from './core/apply-sheet.js'
import { validateSku, summarizeValidation } from './core/validate.js'
import { collectOverrideFonts } from './core/rules.js'
import { formatPreflightReport } from './core/mapping.js'
import {
  applyTextOverrides,
  cloneDoc,
  mergeOverrideLists,
  mergeTextOverride,
  pxPerPtOf,
  fontFamilyOf,
  readFontPostScriptName,
} from './core/text.js'
import { drawScene, measureContent, DEFAULT_SETTINGS, DEFAULT_ADJUST } from './core/fit.js'
import { sanitizeName, uniqueName } from './core/export.js'
import { renderView } from './core/view.js'
import { calibrateText } from './core/calibrate.js'
import { draftRules } from './core/draft-rules.js'

setCanvasFactory((width, height) => createCanvas(width, height))
initializeCanvas((width, height) => createCanvas(width, height))

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'])

const templateCache = new Map()

/** Every family name this process registered, for status and project files. */
const registeredFamilies = new Set()

/**
 * Register font files under every name a text layer may ask for: the file
 * stem, the PostScript name from the font's name table (what PSD styles
 * carry), and the mapped system family ("SourceHanSansCN-Bold" → "Noto Sans
 * SC"). `dir` may be a folder or a single file; `paths` lists files.
 */
async function registerFonts(cwd, { dir, paths } = {}) {
  const files = []
  if (dir) {
    const absolute = await resolveInWorkspace(cwd, dir)
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
  for (const item of paths || []) files.push(await resolveInWorkspace(cwd, item))

  const registered = []
  const skipped = []
  for (const full of files) {
    const extension = path.extname(full).toLowerCase()
    if (!FONT_EXTENSIONS.has(extension)) {
      skipped.push(path.basename(full))
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
          registeredFamilies.add(alias)
          ok = true
        }
      } catch {
        /* this alias is taken by another face */
      }
    }
    if (!ok) skipped.push(path.basename(full))
  }
  return { registered: [...new Set(registered)], skipped }
}

/** Families a template's text layers (and its text edits) ask for. */
function templateFamilies(doc) {
  const families = new Set()
  for (const entry of doc.entries) {
    for (const run of entry.text?.runs || []) if (run.family) families.add(run.family)
  }
  for (const edit of doc.textEdits?.values() || []) {
    if (edit.font) families.add(String(edit.font))
    for (const run of edit.runs || []) if (run.family) families.add(String(run.family))
  }
  return [...families].sort()
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve a workspace path. Reads follow symlinks and must land inside the
 * workspace. Writes (`mustExist: false`) check the real path of the target
 * when it exists (a symlink must not lead out) and of its nearest existing
 * ancestor, so a linked folder cannot redirect output elsewhere either.
 */
async function resolveInWorkspace(cwd, candidate, { mustExist = true } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('A non-empty path is required')
  }
  const absolute = path.resolve(cwd, candidate)
  if (!isInside(cwd, absolute)) {
    throw new Error(`Path must stay inside the session workspace: ${candidate}`)
  }
  const realCwd = await fs.realpath(cwd).catch(() => cwd)
  const insideWorkspace = (real) => isInside(cwd, real) || isInside(realCwd, real)
  const outside = () => new Error(`Path resolves outside the session workspace: ${candidate}`)

  if (mustExist) {
    let real
    try {
      real = await fs.realpath(absolute)
    } catch {
      throw new Error(`Path does not exist: ${candidate}`)
    }
    if (!insideWorkspace(real)) throw outside()
    return real
  }

  const link = await fs.lstat(absolute).catch(() => null)
  if (link) {
    // A dangling link would make the write create its target, wherever it is.
    const real = await fs.realpath(absolute).catch(() => null)
    if (!real || !insideWorkspace(real)) throw outside()
  }
  let ancestor = path.dirname(absolute)
  for (;;) {
    const real = await fs.realpath(ancestor).catch(() => null)
    if (real) {
      if (!insideWorkspace(real)) throw outside()
      break
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return absolute
}

/**
 * psd_edit state per template path. It lives outside the parse cache, which
 * only keeps two documents: looking at other templates must not throw away
 * unsaved edits. The state is dropped only when the PSD itself changes on
 * disk, because its layer ids may no longer mean the same layers.
 */
const editStates = new Map()

function editStateFor(absolutePath, stat) {
  let state = editStates.get(absolutePath)
  if (state && (state.mtimeMs !== stat.mtimeMs || state.size !== stat.size)) {
    const hadEdits = state.textEdits.size > 0 || state.elements.length > 0 || !!state.pinnedSlots
    state = { ...freshEditState(stat), dropped: hadEdits ? 'template changed on disk since the edits were made' : undefined }
    editStates.set(absolutePath, state)
  }
  if (!state) {
    state = freshEditState(stat)
    editStates.set(absolutePath, state)
  }
  return state
}

function freshEditState(stat) {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    textEdits: new Map(),
    elements: [],
    pinnedSlots: null,
    history: [],
  }
}

function snapshotEdits(state) {
  return {
    textEdits: [...state.textEdits.entries()].map(([key, value]) => [key, { ...value }]),
    elements: state.elements.slice(),
    pinnedSlots: state.pinnedSlots ? [...state.pinnedSlots] : null,
  }
}

function pushHistory(doc, absolutePath) {
  const state = editStates.get(absolutePath)
  if (!state) return
  state.history = state.history || []
  state.history.push(snapshotEdits(state))
  if (state.history.length > 20) state.history.shift()
}

function restoreSnapshot(doc, snapshot) {
  doc.textEdits = new Map(snapshot.textEdits)
  doc.elements = snapshot.elements.slice()
  doc.pinnedSlots = snapshot.pinnedSlots ? new Set(snapshot.pinnedSlots) : null
  if (snapshot.pinnedSlots) doc.slots = new Set(snapshot.pinnedSlots)
}

function applyVisibility(doc, specs, results = []) {
  for (const spec of specs || []) {
    const matches = findEntries(doc, spec.layer)
    if (!matches.length) {
      results.push({ layer: spec.layer, ok: false, error: 'layer not found' })
      continue
    }
    for (const entry of matches) {
      if (spec.hidden) doc.hidden.add(entry.id)
      else doc.hidden.delete(entry.id)
      results.push({ layer: spec.layer, ok: true, hidden: !!spec.hidden, id: entry.id })
    }
  }
  return results
}

/** Expose the path's edit state as doc.textEdits / elements / pinnedSlots. */
function attachEditState(doc, absolutePath) {
  if (doc.__editPath === absolutePath) return
  Object.defineProperty(doc, '__editPath', { value: absolutePath, enumerable: false })
  for (const key of ['textEdits', 'elements', 'pinnedSlots']) {
    // Enumerable, so cloneDoc's spread carries the current values along.
    Object.defineProperty(doc, key, {
      enumerable: true,
      configurable: true,
      get: () => editStates.get(absolutePath)[key],
      set: (value) => {
        editStates.get(absolutePath)[key] = value
      },
    })
  }
}

async function loadTemplateDoc(absolutePath) {
  const stat = await fs.stat(absolutePath)
  editStateFor(absolutePath, stat)
  const cached = templateCache.get(absolutePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    attachEditState(cached.doc, absolutePath)
    return cached.doc
  }

  const buffer = await fs.readFile(absolutePath)
  const doc = await parseTemplate({
    name: path.basename(absolutePath),
    size: stat.size,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })
  if (templateCache.size >= 2) templateCache.delete(templateCache.keys().next().value)
  templateCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, doc })
  attachEditState(doc, absolutePath)
  return doc
}

/**
 * Point every override at its layer's entry id, so the same layer named by
 * name in one list and by id in another still merges as one layer and the
 * priority order (psd_edit < text < textBySku) holds.
 */
function canonicalOverrides(doc, list) {
  if (!Array.isArray(list) || list.length === 0) return list
  return list.map((override) => {
    const target = String(override.layer ?? '')
    const matches = findEntries(doc, target)
    const textMatches = matches.filter((item) => item.text)
    const entry = textMatches[0] || matches[0]
    return entry ? { ...override, layer: entry.id } : override
  })
}

function resolveSlots(doc, specs) {
  const ids = []
  const missing = []
  for (const spec of specs) {
    if (/^l\d+$/.test(spec) && doc.leaves.some((leaf) => leaf.id === spec)) {
      ids.push(spec)
      continue
    }
    const matches = findLeaves(doc, spec)
    if (matches.length === 0) {
      missing.push(spec)
      continue
    }
    if (matches.length > 1) {
      const visible = matches.filter((leaf) => isLeafVisible(doc, leaf))
      if (visible.length === 1) {
        ids.push(visible[0].id)
        continue
      }
      throw new Error(
        `Layer name is ambiguous (${matches.length} matches): ${spec}. Use one of the layer ids or a full path: ${matches
          .map((leaf) => leaf.fullName || leaf.id)
          .join(', ')}`,
      )
    }
    ids.push(matches[0].id)
  }
  if (!ids.length && missing.length) {
    const names = doc.leaves.map((leaf) => leaf.fullName || leaf.name)
    throw new Error(`Layer not found: ${missing.join(', ')}. Pixel layers: ${names.join(' | ')}`)
  }
  return ids
}

function slotSummary(doc, ids) {
  return ids.map((id) => {
    const leaf = doc.leaves.find((item) => item.id === id)
    return {
      name: leaf.name,
      leafId: leaf.id,
      bounds: [leaf.left, leaf.top, leaf.left + leaf.width, leaf.top + leaf.height],
    }
  })
}

function toAdjustment(raw) {
  const adjust = { ...DEFAULT_ADJUST }
  if (!raw || typeof raw !== 'object') return adjust
  for (const key of ['dx', 'dy', 'scale', 'rotation']) {
    const value = Number(raw[key])
    if (Number.isFinite(value)) adjust[key] = value
  }
  return adjust
}

/** One line per text layer (first 12), so the agent sees copy before rendering. */
function describeTextLayers(layers) {
  const lines = layers
    .filter((layer) => layer.textContent != null)
    .slice(0, 12)
    .map((layer) => {
      const run = (layer.runs || [])[0]
      const font = run ? ` ${run.family || '?'} ${run.size}pt` : ''
      return `  ${layer.name}: ${JSON.stringify(layer.textContent)}${font}`
    })
  return lines.length ? `\nText layers:\n${lines.join('\n')}` : ''
}

async function listSkuFiles(cwd, { skus, skuDir }) {
  const files = []
  if (Array.isArray(skus)) {
    for (const entry of skus) files.push(await resolveInWorkspace(cwd, entry))
  }
  if (skuDir) {
    const directory = await resolveInWorkspace(cwd, skuDir)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
      if (!entry.isFile()) continue
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      files.push(path.join(directory, entry.name))
    }
  }
  return files
}

/** Inspect a template: dimensions, layer tree, auto-detected product slots. */
export async function inspectTemplate({ cwd, template }) {
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)
  const layerLimit = 400
  const layers = doc.entries
    .filter((entry) => entry.kind === 'group' || entry.leafId)
    .slice(0, layerLimit)
    .map((entry) => {
      const layer = {
        name: entry.name,
        kind: entry.kind,
        depth: entry.depth,
        visible: isEntryVisible(doc, entry.id),
      }
      if (entry.fullName && entry.fullName !== entry.name) layer.fullName = entry.fullName
      if (entry.name !== entry.name.trim()) layer.namePadded = true
      if (entry.leafId) layer.leafId = entry.leafId
      if (entry.kind === 'text') layer.text = true
      if (entry.text) {
        layer.textContent = entry.text.value
        layer.textAlign = entry.text.align
        layer.runCount = entry.text.runs.length
        if (entry.text.runs.length) {
          layer.runs = entry.text.runs
            .slice(0, 8)
            .map(({ family, ...run }) => (family ? { ...run, family } : run))
          layer.runsTruncated = entry.text.runs.length > 8
        }
      }
      if (entry.bounds) layer.bounds = entry.bounds
      return layer
    })

  const suggestedIds = suggestSlots(doc)
  const named = preferredSlotLeaves(doc)
  const slotWarnings = []
  if (!named.length && suggestedIds.length) {
    slotWarnings.push(
      'No layer named product_slot / 商品位 / 产品位; auto-detected slots may be wrong (E01). Pass slots explicitly.',
    )
  }
  const counts = new Map()
  for (const entry of doc.entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1)
  for (const [name, count] of counts) {
    if (count > 1) slotWarnings.push(`Duplicate layer name (${count}): ${JSON.stringify(name)} — use fullName`)
  }
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    layers,
    truncated: doc.entries.length > layerLimit,
    suggestedSlots: slotSummary(doc, suggestedIds),
    namedSlots: slotSummary(doc, named.map((leaf) => leaf.id)),
    anchors: anchorLeaves(doc).slice(0, 40).map((leaf) => ({
      name: leaf.name,
      fullName: leaf.fullName,
      leafId: leaf.id,
      bounds: [leaf.left, leaf.top, leaf.left + leaf.width, leaf.top + leaf.height],
    })),
    ...(slotWarnings.length ? { slotWarnings } : {}),
  }
}

/**
 * Check a value against the small schema subset this file declares (type,
 * enum, items, properties, required, additionalProperties: false). Used where
 * dsh cannot check for us, such as the values of `textBySku`.
 */
function schemaViolations(schema, value, at, out = []) {
  const { type } = schema
  const matches =
    type === 'array'
      ? Array.isArray(value)
      : type === 'object'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer'
          ? Number.isInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type
  if (!matches) {
    out.push(`${at} must be ${type === 'integer' ? 'an integer' : `a${type === 'object' || type === 'array' ? 'n' : ''} ${type}`}`)
    return out
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at} must be one of ${schema.enum.join(', ')}`)
  if (type === 'array' && schema.items) value.forEach((item, index) => schemaViolations(schema.items, item, `${at}[${index}]`, out))
  if (type === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) out.push(`${at}.${key} is required`)
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[key]
      if (sub) schemaViolations(sub, item, `${at}.${key}`, out)
      else if (schema.additionalProperties === false) out.push(`${at}.${key} is not a known field`)
    }
  }
  return out
}

function assertTextBySku(textBySku) {
  if (textBySku == null) return
  const problems = schemaViolations({ type: 'object' }, textBySku, 'textBySku')
  if (!problems.length) {
    for (const [sku, list] of Object.entries(textBySku)) {
      schemaViolations({ type: 'array', items: TEXT_OVERRIDE_SCHEMA }, list, `textBySku[${JSON.stringify(sku)}]`, problems)
    }
  }
  if (problems.length) {
    throw new Error(`Invalid textBySku: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`)
  }
}

/**
 * Render one template with many SKU images into an output directory.
 *
 * @returns {{count:number,outDir:string,files:string[],truncated:boolean,slots:object[],zip?:string}}
 */
function filenameFromSafe(template, values) {
  return String(template || '{sku}.{ext}').replace(/\{(\w+)\}/g, (_, key) =>
    values[key] == null ? '' : String(values[key]),
  )
}

function mimeOf(format) {
  if (format === 'png') return 'image/png'
  if (format === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function encodeCanvas(canvas, format, quality) {
  const mime = mimeOf(format)
  if (format === 'png') return canvas.toBuffer(mime)
  return canvas.toBuffer(mime, Math.round(quality))
}

function resizeCanvas(source, width, height) {
  if (!width && !height) return source
  const w = width || Math.round((source.width * height) / source.height)
  const h = height || Math.round((source.height * width) / source.width)
  if (w === source.width && h === source.height) return source
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

export async function renderBatch({
  cwd,
  template,
  skus = [],
  skuDir,
  slots = [],
  outDir,
  format = 'jpg',
  formats,
  quality = 92,
  fit = 'contain',
  anchor = 'center',
  fill = 1,
  adjustments = {},
  text,
  textBySku,
  fontDir,
  zip = false,
  useSessionEdits = true,
  elements,
  elementsBySku,
  visibility,
  visibilityBySku,
  nameBySku,
  filenameTemplate,
  strictFonts = false,
  sizes,
  manifest = false,
}) {
  assertTextBySku(textBySku)
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)

  const slotIds =
    slots && slots.length > 0
      ? resolveSlots(doc, slots)
      : useSessionEdits && doc.pinnedSlots && doc.pinnedSlots.size
        ? [...doc.pinnedSlots]
        : suggestSlots(doc)
  if (slotIds.length === 0) {
    throw new Error(
      'No product slot was detected. Inspect the layer tree and pass one or more slot layer names.',
    )
  }
  doc.slots = new Set(slotIds)
  doc.scene = buildScene(doc)

  const skuFiles = await listSkuFiles(cwd, { skus, skuDir })
  if (skuFiles.length === 0) {
    throw new Error('No SKU images were found. Pass `skus` paths or a `skuDir` folder.')
  }

  let fontsRegistered
  let fontsSkipped
  if (fontDir) {
    const registration = await registerFonts(cwd, { dir: fontDir })
    fontsRegistered = registration.registered
    fontsSkipped = registration.skipped
  }

  const formatList = (Array.isArray(formats) && formats.length ? formats : [format]).map((item) =>
    String(item).toLowerCase() === 'jpeg' ? 'jpg' : String(item).toLowerCase(),
  )
  for (const item of formatList) {
    if (!['jpg', 'png', 'webp'].includes(item)) throw new Error(`Unsupported format: ${item}`)
  }

  const textWarnings = []
  const savedEdits =
    useSessionEdits && doc.textEdits && doc.textEdits.size
      ? canonicalOverrides(doc, [...doc.textEdits.values()])
      : null
  const batchText = canonicalOverrides(doc, text)
  const neededFonts = new Set(templateFamilies(doc))
  for (const family of collectOverrideFonts(text))
    neededFonts.add(family)
  if (textBySku) {
    for (const list of Object.values(textBySku)) for (const family of collectOverrideFonts(list)) neededFonts.add(family)
  }
  const missingFonts = [...neededFonts].filter((family) => {
    if (!family) return false
    if (GlobalFonts.has(family)) return false
    const mapped = fontFamilyOf(family)
    return !(mapped && GlobalFonts.has(mapped))
  })
  if (strictFonts && missingFonts.length) {
    throw new Error(`Missing fonts (strictFonts): ${missingFonts.join(', ')}`)
  }

  const groups = new Map()
  const used = new Set()
  const primaryExt = formatList[0] === 'png' ? 'png' : formatList[0] === 'webp' ? 'webp' : 'jpg'
  const jobs = skuFiles.map((file, index) => {
    const base = path.basename(file, path.extname(file))
    const fileName = path.basename(file)
    const overrides = mergeOverrideLists(
      mergeOverrideLists(savedEdits, batchText),
      canonicalOverrides(doc, textBySku ? (textBySku[fileName] ?? textBySku[base]) : undefined),
    )
    const vis = [...(visibility || []), ...((visibilityBySku && (visibilityBySku[fileName] || visibilityBySku[base])) || [])]
    const els = [...(elements || []), ...((elementsBySku && (elementsBySku[fileName] || elementsBySku[base])) || [])]
    const signature = JSON.stringify({ overrides, vis, els: els.map((item) => item.source || item) })
    let group = groups.get(signature)
    if (!group) {
      group = { overrides, vis, els, jobs: [] }
      groups.set(signature, group)
    }
    const stem =
      (nameBySku && (nameBySku[fileName] || nameBySku[base])) ||
      (filenameTemplate
        ? filenameFromSafe(filenameTemplate, { sku: base, name: base, ext: primaryExt }).replace(/\.[^.]+$/, '')
        : sanitizeName(base))
    const job = { index, file, base, fileName, vis, els, name: uniqueName(used, sanitizeName(stem), primaryExt) }
    group.jobs.push(job)
    return job
  })
  const textVariants = [...groups.values()].filter((group) => group.overrides).length

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relativeOut = outDir || path.join('out', 'psd-batch', `${sanitizeName(doc.name)}-${stamp}`)
  const absoluteOut = await resolveInWorkspace(cwd, relativeOut, { mustExist: false })
  await fs.mkdir(absoluteOut, { recursive: true })

  const settings = {
    mode: fit || DEFAULT_SETTINGS.mode,
    anchor: anchor || DEFAULT_SETTINGS.anchor,
    fill: Number.isFinite(Number(fill)) ? Number(fill) : DEFAULT_SETTINGS.fill,
  }

  const extraNames = []
  for (const job of jobs) {
    extraNames.push(job.name)
    for (const extra of formatList.slice(1)) extraNames.push(job.name.replace(/\.[^.]+$/, `.${extra}`))
    for (const size of sizes || []) {
      const tag = `${size.width || ''}x${size.height || ''}`
      extraNames.push(job.name.replace(/(\.[^.]+)$/, `-${tag}$1`))
    }
  }
  const zipPath = zip ? path.join(absoluteOut, `${sanitizeName(doc.name)}-${jobs.length}.zip`) : null
  for (const target of [...extraNames.map((name) => path.join(absoluteOut, name)), ...(zipPath ? [zipPath] : [])]) {
    await resolveInWorkspace(cwd, path.relative(cwd, target), { mustExist: false })
  }

  const zipEntries = {}
  const written = []
  const layerResults = []
  let lastScene = doc.scene

  for (const group of groups.values()) {
    const clone = cloneDoc(doc)
    clone.slots = new Set(slotIds)
    clone.hidden = new Set(doc.hidden)
    if (useSessionEdits && doc.elements?.length && !(group.els && group.els.length)) {
      clone.elements = doc.elements
    } else {
      clone.elements = []
      for (const spec of group.els || []) clone.elements.push(await loadElement(cwd, spec, clone))
    }
    applyVisibility(clone, group.vis)
    if (group.overrides) {
      const applied = applyTextOverrides(clone, group.overrides, (family) => GlobalFonts.has(family))
      textWarnings.push(...applied)
      layerResults.push(...(applied.results || []))
    }
    const scene = buildScene(clone)
    lastScene = scene
    try {
      for (const job of group.jobs) {
        const image = await loadImage(job.file)
        const content = measureContent(image)
        const adjust = toAdjustment(adjustments[job.fileName] ?? adjustments[job.base])
        const canvas = createCanvas(doc.width, doc.height)
        const ctx = canvas.getContext('2d')
        if (formatList[0] !== 'png') {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, doc.width, doc.height)
        }
        drawScene(ctx, scene, image, content, settings, adjust)

        const outputs = []
        for (const fmt of formatList) {
          const name = fmt === primaryExt ? job.name : job.name.replace(/\.[^.]+$/, `.${fmt}`)
          const buffer = encodeCanvas(canvas, fmt, quality)
          await fs.writeFile(path.join(absoluteOut, name), buffer)
          outputs.push(name)
          written.push(name)
          if (zip) zipEntries[name] = new Uint8Array(buffer)
        }
        for (const size of sizes || []) {
          const sized = resizeCanvas(canvas, size.width, size.height)
          const fmt = size.format || primaryExt
          const tag = `${size.width || sized.width}x${size.height || sized.height}`
          const name = job.name.replace(/(\.[^.]+)$/, `-${tag}.`) + (fmt === 'jpg' ? 'jpg' : fmt)
          const buffer = encodeCanvas(sized, fmt, size.quality || quality)
          await fs.writeFile(path.join(absoluteOut, name), buffer)
          outputs.push(name)
          written.push(name)
          if (zip) zipEntries[name] = new Uint8Array(buffer)
        }
        job.outputs = outputs
        job.placed = (clone.elements || []).map((element) => ({
          name: element.name,
          left: element.left,
          top: element.top,
          w: element.canvas.width,
          h: element.canvas.height,
          slot: element.slot,
        }))
      }
    } finally {
      if (scene !== doc.scene) disposeScene(scene)
    }
  }

  // Report outputs in input order, not render order: SKUs sharing one text
  // scene are rendered together, which would otherwise reorder the list.
  const files = written.length ? jobs.flatMap((job) => job.outputs || []) : jobs.map((job) => job.name)
  if (zipPath) await fs.writeFile(zipPath, zipSync(zipEntries, { level: 0 }))

  const manifestRows = jobs.map((job) => ({
    sku: job.base,
    source: path.relative(cwd, job.file),
    files: job.outputs || [job.name],
  }))
  if (manifest) {
    const manifestPath = path.join(absoluteOut, 'manifest.json')
    await resolveInWorkspace(cwd, path.relative(cwd, manifestPath), { mustExist: false })
    await fs.writeFile(manifestPath, JSON.stringify(manifestRows, null, 2))
  }

  return {
    count: jobs.length,
    outDir: path.relative(cwd, absoluteOut) || '.',
    files: files.slice(0, 50),
    truncated: files.length > 50,
    slots: (lastScene || doc.scene).slots.map((slot) => ({
      name: slot.name,
      leafId: slot.leafId,
      bounds: [slot.rect.x, slot.rect.y, slot.rect.x + slot.rect.w, slot.rect.y + slot.rect.h],
    })),
    suppressed: (lastScene || doc.scene).suppressed.slice(0, 50),
    suppressedCount: (lastScene || doc.scene).suppressed.length,
    suppressedTruncated: (lastScene || doc.scene).suppressed.length > 50,
    textVariants,
    ...(fontsRegistered ? { fontsRegistered } : {}),
    ...(fontsSkipped && fontsSkipped.length ? { fontsSkipped } : {}),
    ...(textWarnings.length ? { textWarnings: [...new Set(textWarnings)] } : {}),
    ...(missingFonts.length ? { missingFonts } : {}),
    ...(layerResults.length ? { layerResults: layerResults.slice(0, 80) } : {}),
    ...(zipPath ? { zip: path.relative(cwd, zipPath) } : {}),
    ...(manifest ? { manifest: manifestRows } : {}),
  }
}

/**
 * The layer view `validateSku` checks: the template's layers with the job's
 * visibility applied, and each text layer reading as the copy that the render
 * reported it applied (a layer whose override failed keeps its original copy).
 */
async function inspectForValidation(cwd, template, job, layerResults = []) {
  const doc = await loadTemplateDoc(await resolveInWorkspace(cwd, template))
  const clone = cloneDoc(doc)
  applyVisibility(clone, job.visibility)
  const written = new Map()
  for (const item of job.texts || []) {
    if (item.value == null) continue
    // The batch rewrites each override's `layer` to the entry id, so match on
    // the id or the full path as well as the name the rules used.
    const entries = findEntries(clone, item.layer).filter((entry) => entry.text)
    const applied = layerResults.some(
      (result) =>
        result.ok &&
        (result.layer === item.layer ||
          entries.some((entry) => entry.id === result.layer || entry.fullName === result.fullName)),
    )
    if (!applied) continue
    for (const entry of entries) written.set(entry.id, item.value)
  }
  return {
    layers: clone.entries.map((entry) => ({
      name: entry.name,
      fullName: entry.fullName,
      ...(entry.leafId ? { leafId: entry.leafId } : {}),
      visible: isEntryVisible(clone, entry.id),
      ...(entry.bounds ? { bounds: entry.bounds } : {}),
      ...(entry.text ? { textContent: written.has(entry.id) ? written.get(entry.id) : entry.text.value } : {}),
    })),
  }
}

/** Resolve a text layer by entry id, leaf id or layer name. */
function findTextEntry(doc, spec) {
  const wanted = String(spec || '')
  if (!wanted.trim()) throw new Error('A text layer name or id is required')
  const matches = findEntries(doc, wanted)
  const textMatches = matches.filter((entry) => entry.text)
  if (textMatches.length === 1) return textMatches[0]
  if (textMatches.length > 1) {
    throw new Error(
      `Text layer name is ambiguous (${textMatches.length} matches): ${wanted}. Use one of: ${textMatches
        .map((entry) => entry.fullName || entry.id)
        .join(', ')}`,
    )
  }
  const names = doc.entries.filter((entry) => entry.text).map((entry) => entry.fullName || entry.name)
  throw new Error(`Text layer not found: ${wanted}. Text layers: ${names.join(' | ')}`)
}

/** Fields a text override may carry; psd_edit and psd_batch_render share them. */
const TEXT_OVERRIDE_FIELDS = [
  'value',
  'runs',
  'font',
  'weight',
  'size',
  'sizePx',
  'color',
  'tracking',
  'align',
  'leading',
  'dx',
  'dy',
  'fitWidth',
  'minPx',
  'maxPx',
  'decimalScale',
]

/** Scale, rotate and return a canvas for a placed element. */
function composeElement(image, { scale = 1, rotation = 0 } = {}) {
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  if (!rotation) {
    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(image, 0, 0, width, height)
    return canvas
  }
  const radians = (rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const canvas = createCanvas(Math.ceil(width * cos + height * sin), Math.ceil(width * sin + height * cos))
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(radians)
  ctx.drawImage(image, -width / 2, -height / 2, width, height)
  return canvas
}

function rectOfAnchor(doc, spec) {
  if (spec.anchorRect && spec.anchorRect.w != null) return spec.anchorRect
  if (Array.isArray(spec.anchorRect) && spec.anchorRect.length >= 4) {
    const [x0, y0, x1, y1] = spec.anchorRect.map(Number)
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
  }
  if (spec.anchor && doc) return layerBounds(doc, spec.anchor)
  return null
}

async function loadElement(cwd, spec, doc) {
  const file = await resolveInWorkspace(cwd, spec.source)
  const image = await loadImage(file)
  const rotation = Number(spec.rotation) || 0
  let scale = Number(spec.scale) > 0 ? Number(spec.scale) : 1
  let left = Number.isFinite(Number(spec.left)) ? Number(spec.left) : Number(spec.dx) || 0
  let top = Number.isFinite(Number(spec.top)) ? Number(spec.top) : Number(spec.dy) || 0
  const fit = spec.fit || (spec.anchor || spec.anchorRect ? 'contain' : undefined)
  const box = rectOfAnchor(doc, spec)
  if (box && (fit === 'contain' || fit === 'cover')) {
    const content = measureContent(image)
    scale =
      fit === 'cover'
        ? Math.max(box.w / content.w, box.h / content.h)
        : Math.min(box.w / content.w, box.h / content.h)
    left = box.x + box.w / 2 - (content.x + content.w / 2) * scale
    top = box.y + box.h / 2 - (content.y + content.h / 2) * scale
  }
  return {
    name: spec.name ? String(spec.name) : path.basename(file, path.extname(file)),
    source: path.relative(cwd, file),
    canvas: composeElement(image, { scale, rotation }),
    left,
    top,
    scale,
    rotation,
    opacity: spec.opacity == null ? 1 : Math.max(0, Math.min(1, Number(spec.opacity))),
    blend: spec.blend || 'normal',
    aboveSlots: spec.aboveSlots !== false,
    slot: spec.slot,
    fit: fit || null,
    anchor: spec.anchor || null,
  }
}

function currentSlots(doc) {
  return [...(doc.pinnedSlots && doc.pinnedSlots.size ? doc.pinnedSlots : doc.slots || [])]
}

function serializeProject(doc, template) {
  return {
    version: 2,
    template,
    slots: currentSlots(doc),
    textEdits: Object.fromEntries(doc.textEdits),
    elements: doc.elements.map(({ canvas: _canvas, ...element }) => element),
    fonts: [...registeredFamilies].sort(),
  }
}

/**
 * Read a project into a fresh state without touching the document. Every
 * slot, text layer and element source is validated and loaded first, so a
 * missing asset fails the load instead of leaving half a project applied.
 */
async function readProject(doc, cwd, project) {
  if (!project || typeof project !== 'object') throw new Error('Project file is not a JSON object')
  const slots = Array.isArray(project.slots) ? project.slots.map(String) : []
  for (const id of slots) {
    if (!doc.leaves.some((leaf) => leaf.id === id)) throw new Error(`Project slot not in this template: ${id}`)
  }
  const textEdits = new Map()
  for (const [key, raw] of Object.entries(project.textEdits || {})) {
    const entry = findTextEntry(doc, key)
    textEdits.set(entry.id, { ...pickOverride(raw), layer: entry.id })
  }
  const elements = []
  for (const spec of project.elements || []) {
    if (!spec || !spec.source) throw new Error('Project element without a `source` image')
    try {
      elements.push(await loadElement(cwd, spec, doc))
    } catch (error) {
      throw new Error(`Project element ${spec.name || spec.source}: ${error.message || error}`)
    }
  }
  return { slots, textEdits, elements }
}

function pickOverride(raw) {
  const out = {}
  for (const key of TEXT_OVERRIDE_FIELDS) if (raw && raw[key] != null) out[key] = raw[key]
  return out
}

function missingFamilies(doc) {
  return templateFamilies(doc).filter((family) => !GlobalFonts.has(family))
}

/**
 * Edit a template in place: copy, per-run styles, placed elements, fonts and
 * the project file. Text edits are stored as overrides in the same shape as
 * psd_batch_render's `text`, on the cached document, so the next render picks
 * them up (its own `text`/`textBySku` still win per layer).
 */
export async function editTemplate(options) {
  const { cwd, template, action } = options
  if (!action) throw new Error('An action is required')
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)
  if (!doc.textEdits) doc.textEdits = new Map()
  if (!doc.elements) doc.elements = []

  if (action === 'status') {
    return {
      template: path.relative(cwd, absolute) || template,
      slots: currentSlots(doc),
      slotsPinned: !!(doc.pinnedSlots && doc.pinnedSlots.size),
      ...(editStates.get(absolute)?.dropped ? { editsDropped: editStates.get(absolute).dropped } : {}),
      textEdits: [...doc.textEdits.keys()],
      elements: doc.elements.map((element) => element.name),
      fonts: [...registeredFamilies].sort(),
      neededFonts: templateFamilies(doc),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'undo') {
    const state = editStates.get(absolute)
    const snapshot = state?.history?.pop()
    if (!snapshot) return { ok: false, reason: 'nothing to undo' }
    restoreSnapshot(doc, snapshot)
    return {
      ok: true,
      remaining: state.history.length,
      textEdits: [...doc.textEdits.keys()],
      elements: doc.elements.map((element) => element.name),
    }
  }

  if (action === 'diff') {
    const diffs = []
    for (const edit of doc.textEdits.values()) {
      const entry = doc.entries.find((item) => item.id === edit.layer)
      diffs.push({
        layer: entry?.fullName || entry?.name || edit.layer,
        from: entry?.text?.value ?? null,
        to: edit.value ?? null,
      })
    }
    return { textEdits: diffs, elements: doc.elements.map((element) => element.name) }
  }

  if (action === 'text') {
    pushHistory(doc, absolute)
    const entry = findTextEntry(doc, options.layer)
    const patch = pickOverride(options)
    if (!Object.keys(patch).length) {
      throw new Error(`Pass at least one of: ${TEXT_OVERRIDE_FIELDS.join(', ')}`)
    }
    const edit = { ...(doc.textEdits.get(entry.id) || {}), ...patch, layer: entry.id }
    // Dry run against the original geometry, so the reply shows what renders.
    const leaf = doc.leaves.find((item) => item.id === entry.leafId)
    const pxPerPt = leaf ? pxPerPtOf(entry.text, (leaf.__raster || leaf).height) : 0
    const effective = mergeTextOverride(entry.text, edit, pxPerPt) || entry.text
    doc.textEdits.set(entry.id, edit)
    const missing = [...new Set(effective.runs.map((run) => run.family).filter(Boolean))].filter(
      (family) => !GlobalFonts.has(family),
    )
    return {
      layer: entry.name,
      entryId: entry.id,
      value: effective.value,
      runs: effective.runs.map((run) => ({
        len: run.len,
        family: run.family,
        weight: run.weight,
        size: run.size,
        sizePx: Math.round(run.size * pxPerPt * 100) / 100,
        color: run.color,
      })),
      ...(missing.length
        ? { warning: `Font not registered, the canvas will fall back: ${missing.join(', ')}` }
        : {}),
    }
  }

  if (action === 'element') {
    if (!Array.isArray(options.paths) || options.paths.length === 0) {
      throw new Error('Pass `paths` with one or more images')
    }
    pushHistory(doc, absolute)
    const loaded = []
    const cells = []
    if ((options.anchor || options.anchorRect) && options.paths.length > 1) {
      const box = rectOfAnchor(doc, options)
      if (box) {
        const gap = 8
        const width = (box.w - gap * (options.paths.length - 1)) / options.paths.length
        options.paths.forEach((_, index) => {
          cells.push({ x: box.x + index * (width + gap), y: box.y, w: width, h: box.h })
        })
      }
    }
    for (const [index, source] of options.paths.entries()) {
      loaded.push(
        await loadElement(
          cwd,
          {
            source,
            name: options.paths.length === 1 ? options.name : undefined,
            left: options.dx,
            top: options.dy,
            scale: options.scale,
            rotation: options.rotation,
            opacity: options.opacity,
            blend: options.blend,
            aboveSlots: options.aboveSlots,
            anchor: options.anchor,
            anchorRect: cells[index] || options.anchorRect,
            fit: options.fit,
          },
          doc,
        ),
      )
    }
    doc.elements.push(...loaded)
    return {
      placed: loaded.map((element) => ({
        name: element.name,
        left: element.left,
        top: element.top,
        w: element.canvas.width,
        h: element.canvas.height,
        aboveSlots: element.aboveSlots,
      })),
      total: doc.elements.length,
    }
  }

  if (action === 'remelement') {
    const names = (options.names || []).map(String)
    if (names.length === 0) throw new Error('Pass `names` with the elements to remove')
    pushHistory(doc, absolute)
    const before = doc.elements.length
    doc.elements = doc.elements.filter((element) => !names.includes(element.name))
    return {
      removed: before - doc.elements.length,
      total: doc.elements.length,
      names: doc.elements.map((element) => element.name),
    }
  }

  if (action === 'fonts') {
    const paths = options.fonts || options.paths
    if (!options.dir && !(paths && paths.length)) throw new Error('Pass `dir` or `fonts` with font files to register')
    const result = await registerFonts(cwd, { dir: options.dir, paths })
    return {
      loaded: result.registered,
      skipped: result.skipped,
      registered: [...registeredFamilies].sort(),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'save_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to write')
    const projectPath = await resolveInWorkspace(cwd, options.project, { mustExist: false })
    await fs.mkdir(path.dirname(projectPath), { recursive: true })
    // Re-check after mkdir: the folder that now exists must still be ours.
    await resolveInWorkspace(cwd, path.relative(cwd, projectPath), { mustExist: false })
    const data = serializeProject(doc, path.relative(cwd, absolute))
    await fs.writeFile(projectPath, JSON.stringify(data, null, 2))
    return {
      project: path.relative(cwd, projectPath),
      textEdits: Object.keys(data.textEdits).length,
      elements: data.elements.length,
      slots: data.slots,
    }
  }

  if (action === 'load_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to read')
    const projectPath = await resolveInWorkspace(cwd, options.project)
    let project
    try {
      project = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    } catch (error) {
      throw new Error(`Project file is not valid JSON: ${error.message || error}`)
    }
    const next = await readProject(doc, cwd, project)
    pushHistory(doc, absolute)
    // Everything loaded: swap the whole state in one step.
    doc.textEdits = next.textEdits
    doc.elements = next.elements
    doc.pinnedSlots = next.slots.length ? new Set(next.slots) : null
    editStates.get(absolute).dropped = undefined
    if (next.slots.length) doc.slots = new Set(next.slots)
    return {
      project: path.relative(cwd, projectPath),
      textEdits: doc.textEdits.size,
      elements: doc.elements.length,
      slots: currentSlots(doc),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'reset') {
    pushHistory(doc, absolute)
    doc.textEdits = new Map()
    doc.elements = []
    doc.pinnedSlots = null
    editStates.get(absolute).dropped = undefined
    return { ok: true, textEdits: 0, elements: 0 }
  }

  throw new Error(
    `Unknown action: ${action}. Use status / text / element / remelement / fonts / save_project / load_project / reset / undo / diff`,
  )
}

const TEXT_RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['len'],
  properties: {
    len: { type: 'integer', description: 'Character count of this run.' },
    family: { type: 'string', description: 'Font family or PostScript name.' },
    weight: { type: 'number', description: 'Font weight, 100-900.' },
    size: { type: 'number', description: 'Font size in PSD points.' },
    sizePx: { type: 'number', description: 'Font size in canvas pixels; wins over `size`.' },
    color: { type: 'string', description: 'Fill colour as #rrggbb.' },
    tracking: { type: 'number', description: 'Letter spacing in 1/1000 em, as in Photoshop.' },
  },
}

/** One text override; psd_batch_render `text`/`textBySku` and psd_edit share it. */
const TEXT_OVERRIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layer'],
  properties: {
    layer: { type: 'string', description: 'Text layer name, entry id (e12) or leaf id (l3).' },
    value: { type: 'string', description: 'New copy; characters keep their original styles.' },
    runs: { type: 'array', items: TEXT_RUN_SCHEMA },
    ...Object.fromEntries(
      ['family', 'weight', 'size', 'sizePx', 'color', 'tracking'].map((key) => [
        key === 'family' ? 'font' : key,
        TEXT_RUN_SCHEMA.properties[key],
      ]),
    ),
    align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Paragraph alignment.' },
    leading: { type: 'number', description: 'Fixed line height in PSD points.' },
    dx: { type: 'number', description: 'Horizontal nudge in canvas pixels.' },
    dy: { type: 'number', description: 'Vertical nudge in canvas pixels.' },
    fitWidth: { type: 'number', description: 'Shrink glyphs so the line fits this pixel width.' },
    minPx: { type: 'number', description: 'Lower bound for fitWidth scaling.' },
    maxPx: { type: 'number', description: 'Upper bound for glyph pixel size.' },
    decimalScale: { type: 'number', description: 'Scale factor applied to digits after a decimal point.' },
  },
}

/**
 * The calling session's workspace, which every relative path is anchored at.
 *
 * dsh >= 0.2.1 provides a `workingDirectory` service (what its own fs tools
 * use); dsh 0.2.0 does not, and its fs tools read the session header instead.
 * The service is read through `ctx.reflect.get`, which returns undefined when
 * nothing provides it, because touching an undeclared service on `ctx` throws.
 */
async function resolveSessionCwd(ctx, exec) {
  const service = ctx.reflect?.get?.('workingDirectory')
  if (service && typeof service.ensure === 'function') {
    return service.ensure(exec.agent, exec.signal)
  }
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  throw new Error('This session has no workspace directory; open a workspace and try again')
}

const list = (items) => (items && items.length ? items.join(', ') : 'none')

/** One summary line per psd_edit action, then the full result as JSON. */
function describeEditResult(action, value) {
  let summary
  switch (action) {
    case 'status':
      summary = `${value.textEdits.length} text edit(s); elements: ${list(value.elements)}; slots${
        value.slotsPinned ? ' (from project)' : ''
      }: ${list(value.slots)}; missing fonts: ${list(value.missingFonts)}${
        value.editsDropped ? `; edits dropped: ${value.editsDropped}` : ''
      }`
      break
    case 'text':
      summary = `${value.layer} (${value.entryId}) → ${JSON.stringify(value.value)} in ${value.runs.length} run(s)${
        value.warning ? `. Warning: ${value.warning}` : ''
      }`
      break
    case 'element':
      summary = `placed ${list(value.placed.map((item) => `${item.name} at ${item.left},${item.top} (${item.w}×${item.h})`))}; ${value.total} element(s) total`
      break
    case 'remelement':
      summary = `removed ${value.removed}; remaining: ${list(value.names)}`
      break
    case 'fonts':
      summary = `registered ${list(value.loaded)}; skipped: ${list(value.skipped)}; still missing: ${list(value.missingFonts)}`
      break
    case 'save_project':
      summary = `saved ${value.project}: ${value.textEdits} text edit(s), ${value.elements} element(s), slots ${list(value.slots)}`
      break
    case 'load_project':
      summary = `loaded ${value.project}: ${value.textEdits} text edit(s), ${value.elements} element(s), slots ${list(value.slots)}; missing fonts: ${list(value.missingFonts)}`
      break
    case 'reset':
      summary = 'all text edits, elements and project slots cleared'
      break
    case 'undo':
      summary = value.ok ? `undo ok, ${value.remaining} snapshot(s) left` : value.reason || 'nothing to undo'
      break
    case 'diff':
      summary = `${(value.textEdits || []).length} text edit(s); elements: ${list(value.elements)}`
      break
    default:
      summary = 'done'
  }
  const json = JSON.stringify(value)
  return `psd_edit ${action}: ${summary}\n${json.length > 4000 ? `${json.slice(0, 4000)}…` : json}`
}

function toWorkspacePath(cwd, candidate) {
  if (!candidate) return candidate
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate)
  const relative = path.relative(cwd, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the session workspace: ${candidate}`)
  }
  return relative || '.'
}

async function writeContactSheet(absoluteOut, files, { cols = 4, thumb = 240 } = {}) {
  const images = []
  for (const name of files) {
    if (!/\.(png|jpe?g|webp)$/i.test(name)) continue
    if (name.startsWith('contact-')) continue
    images.push({ name, image: await loadImage(path.join(absoluteOut, name)) })
  }
  if (!images.length) return null
  const columns = Math.min(cols, images.length)
  const rows = Math.ceil(images.length / columns)
  const canvas = createCanvas(columns * thumb, rows * thumb)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#111111'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  images.forEach((item, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const scale = Math.min(thumb / item.image.width, thumb / item.image.height)
    const w = item.image.width * scale
    const h = item.image.height * scale
    ctx.drawImage(item.image, col * thumb + (thumb - w) / 2, row * thumb + (thumb - h) / 2, w, h)
  })
  const file = 'contact-sheet.jpg'
  await fs.writeFile(path.join(absoluteOut, file), canvas.toBuffer('image/jpeg', 90))
  return file
}

/**
 * Requirement sheet → per-SKU psd_batch_render jobs. All inputs are explicit;
 * session edits are ignored (P-07).
 */
export async function applySheet(options) {
  const { cwd } = options
  const sheetPath = await resolveInWorkspace(cwd, options.sheet)
  const mappingPath = options.mapping ? await resolveInWorkspace(cwd, options.mapping) : undefined
  const rulesPath = options.rules ? await resolveInWorkspace(cwd, options.rules) : undefined
  const productDir = options.productDir ? await resolveInWorkspace(cwd, options.productDir) : undefined
  const giftDir = options.giftDir ? await resolveInWorkspace(cwd, options.giftDir) : undefined
  const plan = await planSheet({
    sheetPath,
    sheetName: options.sheetName,
    mappingPath,
    rulesPath,
    productDir,
    giftDir,
    skus: options.skus,
    limit: options.limit,
  })

  const templateList = (options.templates && options.templates.length
    ? options.templates
    : [options.template, ...(plan.rules.templates || [])].filter(Boolean))
  if (!templateList.length) throw new Error('Pass `template` or set rules.templates')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relativeOut = options.outDir || path.join('out', 'psd-sheet', stamp)
  const absoluteOut = await resolveInWorkspace(cwd, relativeOut, { mustExist: false })
  await fs.mkdir(absoluteOut, { recursive: true })

  const formats = options.formats || (options.format ? [options.format] : plan.rules.export?.formats) || ['png', 'jpg']
  const quality = options.quality ?? plan.rules.export?.quality ?? 95
  const slots = options.slots || (plan.rules.slots?.product ? [plan.rules.slots.product].flat() : undefined)
  const strictFonts = options.strictFonts !== false
  const doValidate = options.validate !== false

  const runOne = async (job) => {
    const skuRel = toWorkspacePath(cwd, job.productPath)
    const stem = outputNameFor(job, 'png', plan.rules).replace(/\.[^.]+$/, '')
    const elements = (job.elements || []).map((element) => ({
      ...element,
      source: toWorkspacePath(cwd, element.source),
    }))
    const files = []
    const validations = []
    for (const template of templateList) {
      const tag = templateList.length > 1 ? `-${sanitizeName(path.basename(template, path.extname(template)))}` : ''
      const rendered = await renderBatch({
        cwd,
        template,
        skus: [skuRel],
        slots,
        outDir: relativeOut,
        formats,
        quality,
        fontDir: options.fontDir,
        useSessionEdits: false,
        strictFonts,
        text: job.texts,
        elements,
        visibility: job.visibility,
        nameBySku: {
          [path.basename(skuRel)]: stem + tag,
          [path.basename(skuRel, path.extname(skuRel))]: stem + tag,
        },
        manifest: false,
      })
      files.push(...rendered.files)
      if (doValidate) {
        const imageName = rendered.files.find((name) => /\.(png|jpe?g|webp)$/i.test(name))
        validations.push(
          await validateSku({
            imagePath: imageName ? path.join(cwd, rendered.outDir, imageName) : undefined,
            job,
            inspect: await inspectForValidation(cwd, template, job, rendered.layerResults),
            strictFonts,
            scene: { slots: rendered.slots },
            missingFonts: rendered.missingFonts,
            registered: new Set(rendered.fontsRegistered || []),
            rules: plan.rules,
            placedElements: job.elements,
          }),
        )
      }
    }
    return { sku: job.sku, name: job.name, files, validations, warnings: job.warnings }
  }

  let pending = plan.jobs.slice()
  const results = []
  const failed = []
  for (const job of pending) {
    try {
      const row = await runOne(job)
      const bad = (row.validations || []).some((item) => !item.ok)
      results.push({ ...row, ok: !bad })
      if (bad) failed.push(job)
    } catch (error) {
      const row = { sku: job.sku, name: job.name, ok: false, error: error.message || String(error) }
      results.push(row)
      failed.push(job)
    }
  }

  if (options.retryFailed && failed.length) {
    const retry = []
    for (const job of failed) {
      try {
        const row = await runOne(job)
        const bad = (row.validations || []).some((item) => !item.ok)
        retry.push({ ...row, ok: !bad, retried: true })
      } catch (error) {
        retry.push({ sku: job.sku, name: job.name, ok: false, retried: true, error: error.message || String(error) })
      }
    }
    const bySku = new Map(retry.map((item) => [item.sku, item]))
    for (let index = 0; index < results.length; index += 1) {
      const next = bySku.get(results[index].sku)
      if (next) results[index] = next
    }
  }

  const allFiles = results.flatMap((item) => item.files || [])
  let contact = null
  if (options.contactSheet && allFiles.length) {
    contact = await writeContactSheet(absoluteOut, allFiles)
  }

  const validation = summarizeValidation(results.flatMap((item) => item.validations || []))
  await fs.writeFile(
    path.join(absoluteOut, 'report.json'),
    JSON.stringify(
      {
        sheet: plan.sheetName,
        preflight: plan.preflight,
        skipped: plan.skipped,
        results,
        validation,
      },
      null,
      2,
    ),
  )

  return {
    count: results.length,
    outDir: path.relative(cwd, absoluteOut) || '.',
    files: allFiles.slice(0, 50),
    skipped: plan.skipped,
    failed: results.filter((item) => !item.ok).map((item) => item.sku),
    preflightOk: plan.preflight.ok,
    preflight: formatPreflightReport(plan.preflight),
    validation,
    contactSheet: contact,
    results,
  }
}

/**
 * Register the agent tools for this Host plugin.
 *
 * @param ctx - Host context providing `tools` (and, on dsh >= 0.2.1, a
 *   `workingDirectory` service looked up per call, see `resolveSessionCwd`).
 * @returns disposer removing every tool registration.
 */
export function registerTools(ctx) {
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'psd_inspect',
      description:
        'Inspect a PSD/PSB main-image template inside the session workspace. Returns its size, the layer tree (names, depth, visibility, bounds, ids), product slots the studio would auto-detect, and — for text layers — the copy plus per-run font styles (family, weight, size, color). Use this before psd_batch_render when you need to choose slot layers or check what a text layer says.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'width', 'height', 'layers', 'suggestedSlots'],
          properties: {
            name: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            truncated: { type: 'boolean' },
            layers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'kind', 'depth', 'visible'],
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string' },
                  depth: { type: 'integer' },
                  visible: { type: 'boolean' },
                  text: { type: 'boolean' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                  textContent: { type: 'string' },
                  textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
                  runs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['len'],
                      properties: {
                        len: { type: 'integer' },
                        // dsh only accepts one type per schema node; a run
                        // without a font name simply omits `family`.
                        family: { type: 'string' },
                        weight: { type: 'integer' },
                        size: { type: 'number' },
                        color: { type: 'array', items: { type: 'integer' } },
                        tracking: { type: 'number' },
                      },
                    },
                  },
                  runCount: { type: 'integer' },
                  runsTruncated: { type: 'boolean' },
                  fullName: { type: 'string' },
                  namePadded: { type: 'boolean' },
                },
              },
            },
            namedSlots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
            anchors: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  fullName: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
            slotWarnings: { type: 'array', items: { type: 'string' } },
            suggestedSlots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.name}: ${value.width}×${value.height}, ${value.layers.length} listed layers.\nAuto slots: ${
              value.suggestedSlots.map((slot) => `${slot.name} [${slot.bounds.join(',')}]`).join(' | ') ||
              'none'
            }${describeTextLayers(value.layers)}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_inspect requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return inspectTemplate({ cwd, template: args.template })
      },
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_batch_render',
      description:
        'Render a PSD/PSB main-image template with many SKU images at once. Each SKU image is trimmed to its visible content, fitted into the product slots, composited between the template layers, and written as JPG/PNG into a workspace folder. Visible sibling layers that overlap a slot are suppressed together with the slot (reported as `suppressed`) so stale product art cannot show through. Text layers can be rewritten per batch (`text`) or per SKU (`textBySku`) — re-rendered with real glyphs, not pasted pixels; register brand fonts first with `fontDir`. Returns the output folder and file names; optionally packs a ZIP.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
          skus: {
            type: 'array',
            items: { type: 'string' },
            description: 'SKU image paths (PNG/JPG/WebP) relative to the working directory.',
          },
          skuDir: {
            type: 'string',
            description: 'Directory of SKU images to use instead of listing every file.',
          },
          slots: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Product slot layer names or leaf ids. Omit to use the auto-detected slots reported by psd_inspect.',
          },
          text: {
            type: 'array',
            description:
              'Rewrite text layers in every render: [{layer, value, runs, font, weight, size, sizePx, color, tracking, align, leading, dx, dy}]. `layer` is a layer name or leaf id; `value` replaces the copy (styles follow their characters); `runs` [{len, family?, weight?, size?, sizePx?, color?, tracking?}] restyle consecutive segments from the first character; flat font/weight/size/sizePx/color/tracking restyle all runs. `size` is in pt, exactly what psd_inspect reports; `sizePx` is in canvas pixels; color is #rrggbb. Wins over psd_edit text edits for the same layer.',
            items: TEXT_OVERRIDE_SCHEMA,
          },
          textBySku: {
            type: 'object',
            // dsh only accepts a boolean here, so the per-SKU list shape is
            // checked at call time against TEXT_OVERRIDE_SCHEMA instead.
            additionalProperties: true,
            description:
              'Per-SKU text overrides: {"<SKU file name, with or without extension>": [<item>, ...]}, where each item has exactly the shape of a `text` item ({layer, value?, runs?, font?, weight?, size?, sizePx?, color?, tracking?, align?, leading?, dx?, dy?}). Entries win over `text` and psd_edit text edits per layer. Use it to give every SKU its own price.',
          },
          fontDir: {
            type: 'string',
            description:
              'Directory of .ttf/.otf font files to register before rendering. Registered family names (file stems) are returned in `fontsRegistered`.',
          },
          outDir: {
            type: 'string',
            description: 'Output folder relative to the working directory. Defaults to out/psd-batch/<template>-<time>.',
          },
          format: { type: 'string', enum: ['jpg', 'png', 'webp'], description: 'Output format. Default jpg.' },
          formats: {
            type: 'array',
            items: { type: 'string', enum: ['jpg', 'png', 'webp'] },
            description: 'Write several formats per SKU (P-09). Overrides `format` when set.',
          },
          quality: { type: 'integer', description: 'JPEG quality 1-100. Default 92.' },
          fit: {
            type: 'string',
            enum: ['contain', 'height', 'width', 'cover'],
            description: 'How the SKU content is fitted into a slot. Default contain.',
          },
          anchor: {
            type: 'string',
            enum: ['bottom', 'center', 'top'],
            description: 'Vertical anchor inside the slot. Default center.',
          },
          fill: { type: 'number', description: 'Scale multiplier applied after fitting, e.g. 0.9. Default 1.' },
          adjustments: {
            type: 'object',
            additionalProperties: true,
            description:
              'Optional per-SKU tweaks keyed by file name with or without extension: {"01-a.png":{"dx":12,"dy":-8,"scale":1.05,"rotation":0}}.',
          },
          zip: { type: 'boolean', description: 'Also pack every output into a ZIP. Default false.' },
          useSessionEdits: {
            type: 'boolean',
            description:
              'When false, ignore psd_edit text/elements/slots (P-07). Default true for compatibility.',
          },
          strictFonts: {
            type: 'boolean',
            description: 'Fail the batch if a required font is not registered instead of falling back (P-08).',
          },
          filenameTemplate: {
            type: 'string',
            description: 'Output name template, e.g. {sku}-{name}.{ext}. Default is the SKU file stem.',
          },
          manifest: { type: 'boolean', description: 'Also write manifest.json listing SKU → files.' },
          elements: {
            type: 'array',
            description: 'Images to place for every SKU. Each item: {source, name?, anchor?, fit?, dx?, dy?, scale?}.',
            items: { type: 'object', additionalProperties: true },
          },
          visibility: {
            type: 'array',
            description: 'Show or hide layers: [{layer, hidden}].',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['layer'],
              properties: {
                layer: { type: 'string' },
                hidden: { type: 'boolean' },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'outDir', 'files', 'slots', 'suppressed', 'suppressedCount', 'suppressedTruncated', 'textVariants'],
          properties: {
            count: { type: 'integer' },
            outDir: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            truncated: { type: 'boolean' },
            zip: { type: 'string' },
            slots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
            suppressed: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                },
              },
            },
            suppressedCount: { type: 'integer' },
            suppressedTruncated: { type: 'boolean' },
            textVariants: { type: 'integer' },
            textWarnings: { type: 'array', items: { type: 'string' } },
            fontsRegistered: { type: 'array', items: { type: 'string' } },
            fontsSkipped: { type: 'array', items: { type: 'string' } },
            missingFonts: { type: 'array', items: { type: 'string' } },
            layerResults: { type: 'array', items: { type: 'object', additionalProperties: true } },
            manifest: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Rendered ${value.count} image(s) into ${value.outDir} using ${value.slots
              .map((slot) => slot.name)
              .join(', ')}${
              value.suppressed && value.suppressed.length
                ? `\nSuppressed overlapping slot siblings (hidden with the slot): ${value.suppressed
                    .map((layer) => layer.name)
                    .join(', ')}${
                    value.suppressedTruncated ? ` (+${value.suppressedCount - value.suppressed.length} more)` : ''
                  }`
                : ''
            }${value.textVariants ? `\nText rewritten in ${value.textVariants} variant(s).` : ''}${
              value.fontsRegistered && value.fontsRegistered.length
                ? `\nFonts registered: ${value.fontsRegistered.join(', ')}`
                : ''
            }${
              value.textWarnings && value.textWarnings.length
                ? `\nText warnings: ${value.textWarnings.slice(0, 8).join('；')}`
                : ''
            }${value.zip ? `\nZIP: ${value.zip}` : ''}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_batch_render requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return renderBatch({
          cwd,
          template: args.template,
          skus: args.skus,
          skuDir: args.skuDir,
          slots: args.slots,
          outDir: args.outDir,
          format: args.format,
          formats: args.formats,
          quality: args.quality,
          fit: args.fit,
          anchor: args.anchor,
          fill: args.fill,
          adjustments: args.adjustments,
          text: args.text,
          textBySku: args.textBySku,
          fontDir: args.fontDir,
          zip: args.zip,
          useSessionEdits: args.useSessionEdits !== false,
          strictFonts: args.strictFonts,
          filenameTemplate: args.filenameTemplate,
          manifest: args.manifest,
          elements: args.elements,
          visibility: args.visibility,
        })
      },
      timeoutMs: 20 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_edit',
      description:
        'Edit a loaded PSD/PSB template before rendering: rewrite a text layer (same fields as one psd_batch_render `text` item, so a price line can mix two fonts, sizes and colours), place extra image layers above the product slot or between the background and the slot, register font files, and save or load the project so edits survive between sessions. Edits land on the cached document, so a following psd_batch_render uses them (its own `text`/`textBySku` still win per layer) and, after load_project, the project\'s slots when `slots` is omitted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template', 'action'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
          action: {
            type: 'string',
            enum: [
              'status',
              'text',
              'element',
              'remelement',
              'fonts',
              'save_project',
              'load_project',
              'reset',
              'undo',
              'diff',
            ],
            description:
              'status: current edits, fonts and missing fonts. text: rewrite a text layer. element / remelement: add or remove placed images. fonts: register font files. save_project / load_project: persist edits. reset: drop every edit. undo / diff: revert or inspect edits (C3).',
          },
          // action=text: the same fields as one psd_batch_render `text` item.
          ...TEXT_OVERRIDE_SCHEMA.properties,
          layer: {
            type: 'string',
            description: 'Text layer name, entry id (e12) or leaf id (l3). Required for action=text.',
          },
          dx: { type: 'number', description: 'Horizontal offset in canvas pixels (text nudge, or element left).' },
          dy: { type: 'number', description: 'Vertical offset in canvas pixels (text nudge, or element top).' },
          paths: {
            type: 'array',
            description: 'Images to place (relative paths). Required for action=element.',
            items: { type: 'string' },
          },
          name: { type: 'string', description: 'Element name. Defaults to the file name.' },
          scale: { type: 'number', description: 'Element scale, 1 = original size.' },
          fit: {
            type: 'string',
            enum: ['contain', 'cover'],
            description: 'Fit the image into `anchor` / `anchorRect` instead of passing dx/dy (P-02).',
          },
          anchor: {
            type: 'string',
            description: 'Layer name whose bbox is the placement target for action=element.',
          },
          rotation: { type: 'number', description: 'Element rotation in degrees.' },
          opacity: { type: 'number', description: 'Element opacity, 0-1.' },
          blend: { type: 'string', description: 'Blend mode, e.g. multiply / screen / overlay.' },
          aboveSlots: {
            type: 'boolean',
            description:
              'Draw the element above everything (default true). Set false to place it directly under the lowest product slot, above the background.',
          },
          names: {
            type: 'array',
            description: 'Element names to remove (action=remelement).',
            items: { type: 'string' },
          },
          dir: { type: 'string', description: 'Folder of font files to register (action=fonts).' },
          fonts: {
            type: 'array',
            description: 'Font files to register (action=fonts).',
            items: { type: 'string' },
          },
          project: {
            type: 'string',
            description: 'Project JSON path for action=save_project / load_project.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        // dsh requires `render`: it is what the model reads back.
        render: (args, value) => [{ type: 'text', text: describeEditResult(args.action, value) }],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_edit requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return editTemplate({ cwd, ...args })
      },
      timeoutMs: 5 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_apply_sheet',
      description:
        'Expand a requirement sheet + mapping.csv + template.rules.json into per-SKU renders. Does preflight (missing/ambiguous assets are reported, never fuzzy-matched), writes text/gifts/icon from the rules file, validates outputs, and can retry failures. Prefer this over hand-written layer lists. Session edits are ignored.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sheet', 'template', 'rules'],
        properties: {
          sheet: { type: 'string', description: 'Requirement xlsx/csv path.' },
          sheetName: { type: 'string', description: 'Workbook sheet name. Default from rules.sheet.name.' },
          mapping: { type: 'string', description: 'mapping.csv (sku → product/gift files).' },
          rules: { type: 'string', description: 'template.rules.json next to the PSD.' },
          template: { type: 'string', description: 'PSD/PSB template path.' },
          templates: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional extra templates (main + long-form) (P-10).',
          },
          productDir: { type: 'string', description: 'Folder of product cut-outs.' },
          giftDir: { type: 'string', description: 'Folder of gift cut-outs.' },
          fontDir: { type: 'string', description: 'Font folder to register before rendering.' },
          outDir: { type: 'string' },
          format: { type: 'string', enum: ['jpg', 'png', 'webp'] },
          formats: { type: 'array', items: { type: 'string', enum: ['jpg', 'png', 'webp'] } },
          quality: { type: 'integer' },
          skus: { type: 'array', items: { type: 'string' }, description: 'Only these SKUs.' },
          limit: { type: 'integer', description: 'First N renderable SKUs (use 1–2 for a sample).' },
          validate: { type: 'boolean', description: 'Run post-render checks. Default true.' },
          retryFailed: { type: 'boolean', description: 'Re-render SKUs that failed validation.' },
          contactSheet: { type: 'boolean', description: 'Write a thumbnail contact sheet (C2).' },
          strictFonts: { type: 'boolean', description: 'Block on missing fonts. Default true.' },
          slots: { type: 'array', items: { type: 'string' } },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: `psd_apply_sheet: ${value.count} SKU(s) → ${value.outDir}; failed ${list(
              value.failed,
            )}; skipped ${list((value.skipped || []).map((item) => item.sku))}${value.contactSheet ? `\nContact sheet: ${value.contactSheet}` : ''}\n${value.preflight}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_apply_sheet requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return applySheet({ cwd, ...args })
      },
      timeoutMs: 20 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_view',
      description:
        'Look at a rendered image up close. Crops and zooms a PNG/JPG/WebP in the workspace and writes a PNG you can open, with optional labelled rectangles, a pixel-coordinate grid, and the bounds of named PSD layers drawn on top (all in the image\'s own pixel space, which equals the template canvas for renders). Use it to read exact positions, check whether text is clipped or a gift image fits its card, and to compare where a layer sits against what was actually drawn.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['image'],
        properties: {
          image: { type: 'string', description: 'Image path relative to the session working directory.' },
          crop: {
            type: 'array',
            items: { type: 'number' },
            description: 'Region [x0, y0, x1, y1] in image pixels. Default: the whole image.',
          },
          scale: { type: 'number', description: 'Zoom factor (max 16). Default: fit the crop to about 1600px wide.' },
          grid: {
            type: 'number',
            description: 'Draw a coordinate grid every N pixels. 0 draws none; omit for none, -1 for an automatic step.',
          },
          rects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rect'],
              properties: {
                rect: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] in image pixels.' },
                label: { type: 'string' },
                color: { type: 'string', description: 'CSS colour. Default cycles through a palette.' },
              },
            },
            description: 'Rectangles to draw.',
          },
          template: {
            type: 'string',
            description: 'PSD/PSB path; required when `layers` or `textLayers` is used.',
          },
          layers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Layer names, full paths or ids whose bounds to outline and label.',
          },
          textLayers: { type: 'boolean', description: 'Outline every visible text layer of `template`.' },
          outDir: { type: 'string', description: 'Output folder relative to the working directory. Default out/_view.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            source: {
              type: 'object',
              additionalProperties: false,
              properties: { width: { type: 'integer' }, height: { type: 'integer' } },
            },
            crop: { type: 'array', items: { type: 'integer' } },
            scale: { type: 'number' },
            rects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { label: { type: 'string' }, rect: { type: 'array', items: { type: 'number' } } },
              },
            },
            missing: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `psd_view: ${value.file} (${value.width}×${value.height}, crop [${value.crop.join(', ')}], ×${value.scale}, ${value.rects.length} rect(s)${value.missing.length ? `; not found: ${value.missing.join(', ')}` : ''})`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_view requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        const imagePath = await resolveInWorkspace(cwd, args.image)
        if (!IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
          throw new Error(`Not an image file: ${args.image}`)
        }
        const image = await loadImage(await fs.readFile(imagePath))

        const rects = (args.rects || []).map((item) => ({ ...item }))
        const missing = []
        const wantsTemplate = (args.layers && args.layers.length) || args.textLayers
        if (wantsTemplate) {
          if (!args.template) throw new Error('Pass `template` to outline layers')
          const doc = await loadTemplateDoc(await resolveInWorkspace(cwd, args.template))
          for (const spec of args.layers || []) {
            const found = layerBounds(doc, spec)
            if (!found) missing.push(spec)
            else rects.push({ rect: [found.x, found.y, found.x + found.w, found.y + found.h], label: spec.split('/').pop() })
          }
          if (args.textLayers) {
            for (const entry of doc.entries) {
              if (entry.kind !== 'text' || !entry.bounds || !isEntryVisible(doc, entry.id)) continue
              rects.push({ rect: entry.bounds, label: entry.name.trim() })
            }
          }
        }

        const grid = args.grid === -1 ? true : Number(args.grid) > 0 ? Number(args.grid) : false
        const view = renderView({ image, crop: args.crop, scale: args.scale, rects, grid })

        const outDir = toWorkspacePath(cwd, args.outDir || 'out/_view')
        const absoluteOut = await resolveInWorkspace(cwd, outDir, { mustExist: false })
        await fs.mkdir(absoluteOut, { recursive: true })
        const crop = view.crop
        const stem = sanitizeName(path.basename(imagePath, path.extname(imagePath)))
        const file = `${stem}-${crop.x}_${crop.y}_${crop.w}x${crop.h}-x${view.scale}.png`
        await fs.writeFile(path.join(absoluteOut, file), view.canvas.toBuffer('image/png'))

        return {
          file: path.join(outDir, file),
          width: view.canvas.width,
          height: view.canvas.height,
          source: { width: image.width, height: image.height },
          crop: [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h],
          scale: view.scale,
          rects: view.rects,
          missing,
        }
      },
      timeoutMs: 60 * 1000,
      isConcurrencySafe: () => true,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_text_check',
      description:
        'Measure how closely the text engine reproduces the template\'s own text. Re-renders every text layer of a PSD/PSB with its ORIGINAL copy and compares ink bounds with the pixels Photoshop rasterized: size ratios (1 = identical), centre offsets in px, and whether a font had to fall back. A row marked `drift` means rewriting that layer will not sit where the designer put it (wrong size, baseline or font); fix the font or the rule before a batch run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: { type: 'string', description: 'PSD or PSB path relative to the session working directory.' },
          fontDir: { type: 'string', description: 'Font folder to register before measuring.' },
          layers: { type: 'array', items: { type: 'string' }, description: 'Only these layer names, full paths or ids.' },
          tolerance: { type: 'number', description: 'Allowed size error as a fraction. Default 0.05.' },
          offset: { type: 'number', description: 'Allowed centre offset in px. Default 4.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            template: { type: 'string' },
            total: { type: 'integer' },
            drift: { type: 'integer' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  layer: { type: 'string' },
                  text: { type: 'string' },
                  ok: { type: 'boolean' },
                  drift: { type: 'boolean' },
                  note: { type: 'string' },
                  widthRatio: { type: 'number' },
                  heightRatio: { type: 'number' },
                  dx: { type: 'number' },
                  dy: { type: 'number' },
                  orig: { type: 'array', items: { type: 'number' } },
                  rendered: { type: 'array', items: { type: 'number' } },
                  warnings: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `psd_text_check: ${value.total} text layer(s), ${value.drift} drifting\n${value.rows
              .map(
                (row) =>
                  `${row.drift ? '✗' : '✓'} ${row.layer}  ${
                    row.ok ? `W×${row.widthRatio} H×${row.heightRatio} dx${row.dx} dy${row.dy}` : row.note
                  }${row.warnings && row.warnings.length ? `  [${row.warnings.join('; ')}]` : ''}`,
              )
              .join('\n')}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_text_check requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        const absolute = await resolveInWorkspace(cwd, args.template)
        if (args.fontDir) await registerFonts(cwd, { dir: args.fontDir })
        const doc = await loadTemplateDoc(absolute)
        const tolerance = Number(args.tolerance) > 0 ? Number(args.tolerance) : 0.05
        const offset = Number(args.offset) > 0 ? Number(args.offset) : 4
        const rows = calibrateText(doc, (family) => GlobalFonts.has(family), { layers: args.layers }).map((row) => {
          const { topGap: _top, bottomGap: _bottom, ...rest } = row
          const warnings = (rest.warnings || []).map(String)
          const drift =
            !rest.ok ||
            warnings.length > 0 ||
            Math.abs(rest.widthRatio - 1) > tolerance ||
            Math.abs(rest.heightRatio - 1) > tolerance * 3 ||
            Math.abs(rest.dx) > offset ||
            Math.abs(rest.dy) > offset
          return { ...rest, warnings, drift }
        })
        return { template: path.relative(cwd, absolute), total: rows.length, drift: rows.filter((row) => row.drift).length, rows }
      },
      timeoutMs: 2 * 60 * 1000,
      isConcurrencySafe: () => true,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_draft_rules',
      description:
        'Draft a template.rules.json from a PSD/PSB alone: tags each layer (price, headline / sub-head / detail copy, product name, gift titles and names, icons, product slot), reads fonts, true pixel sizes and colours from the file, and computes gift picture zones between each title and name. Every tag carries its evidence and anything undecidable is listed in `unresolved`; copy-hierarchy rules, size bins by text length and unseen gift tiers still have to come from the modification note. Optionally writes the draft to a file for psd_apply_sheet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: { type: 'string', description: 'PSD or PSB path relative to the session working directory.' },
          giftDir: { type: 'string', description: 'Folder of gift cut-outs; its file names seed gifts.catalog.' },
          sheetName: { type: 'string', description: 'Requirement workbook sheet name to record in the rules.' },
          outRules: { type: 'string', description: 'Write the draft rules JSON here (relative path).' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing outRules file. Default false.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            written: { type: 'string' },
            unresolved: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `psd_draft_rules: ${Object.keys(value.rules.layers).length} layer(s) tagged${value.rules.slots?.product ? ', product slot found' : ', NO product slot'}${
              value.written ? `, written to ${value.written}` : ''
            }\n${Object.entries(value.evidence)
              .map(([key, item]) => `  ${key} → ${item.layer}  (${item.reason})`)
              .join('\n')}${value.unresolved.length ? `\nunresolved:\n  ${value.unresolved.join('\n  ')}` : ''}\nnotes:\n  ${value.notes.join('\n  ')}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_draft_rules requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        const absolute = await resolveInWorkspace(cwd, args.template)
        const doc = await loadTemplateDoc(absolute)
        let giftFiles = []
        if (args.giftDir) {
          const dir = await resolveInWorkspace(cwd, args.giftDir)
          giftFiles = (await fs.readdir(dir))
            .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.startsWith('.'))
            .sort()
        }
        const draft = draftRules(doc, { giftFiles, sheetName: args.sheetName, templateName: path.basename(absolute) })
        let written
        if (args.outRules) {
          const target = await resolveInWorkspace(cwd, args.outRules, { mustExist: false })
          const exists = await fs.stat(target).then(() => true, () => false)
          if (exists && !args.overwrite) throw new Error(`${args.outRules} already exists; pass overwrite: true to replace it`)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, `${JSON.stringify(draft.rules, null, 2)}\n`)
          written = path.relative(cwd, target)
        }
        return { ...draft, ...(written ? { written } : {}) }
      },
      timeoutMs: 2 * 60 * 1000,
      isConcurrencySafe: () => true,
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
