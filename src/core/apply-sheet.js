/**
 * Turn a requirement sheet + mapping + rules JSON into per-SKU render jobs.
 * Rendering itself stays in server.js so this module stays testable.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expandRow, filenameFromTemplate, sanitizeFilename } from './rules.js'
import { exactProductFile, isNoteRow, listImages, loadMappingTable, loadRequirementSheet, preflight } from './mapping.js'
import { normalizeRecord } from './sheet.js'
import { DEFAULT_COLUMN_ALIASES } from './sheet.js'

export async function loadRulesFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8')
  return JSON.parse(text)
}

function mappingFor(sku, table) {
  return (table.records || []).map((row) => normalizeRecord(row.raw || row)).find((row) => row.sku === sku) || {}
}

function splitAnchor(rect, count) {
  if (!rect || count <= 1) return [rect]
  const gap = 8
  const width = (rect.w - gap * (count - 1)) / count
  return Array.from({ length: count }, (_, index) => ({
    x: rect.x + index * (width + gap),
    y: rect.y,
    w: width,
    h: rect.h,
  }))
}

export function elementsForJob(job, rules, { giftDir } = {}) {
  const slots = rules.gifts?.slots || []
  const elements = []
  job.gifts.forEach((gift, index) => {
    const slot = slots[index] || {}
    const bounds = slot.anchor?.bounds || slot.bounds
    const rect = Array.isArray(bounds)
      ? { x: bounds[0], y: bounds[1], w: bounds[2] - bounds[0], h: bounds[3] - bounds[1] }
      : bounds
    const files = gift.files || []
    const cells = splitAnchor(rect, files.length)
    files.forEach((file, fileIndex) => {
      const cell = cells[fileIndex] || rect
      elements.push({
        source: giftDir ? path.join(giftDir, file) : file,
        name: `el-${gift.slot}-${path.basename(file, path.extname(file))}`,
        anchorRect: cell,
        fit: 'contain',
        slot: gift.slot,
        aboveSlots: true,
      })
    })
  })
  return elements
}

export async function planSheet({
  sheetPath,
  sheetName,
  mappingPath,
  rulesPath,
  rules,
  productDir,
  giftDir,
  aliases = DEFAULT_COLUMN_ALIASES,
  skus,
  limit,
} = {}) {
  const loadedRules = rules || (rulesPath ? await loadRulesFile(rulesPath) : {})
  const sheet = await loadRequirementSheet(sheetPath, {
    sheetName: sheetName || loadedRules.sheet?.name,
    aliases: { ...aliases, ...(loadedRules.sheet?.columns || {}) },
  })
  const mappingTable = mappingPath ? await loadMappingTable(mappingPath) : { records: [] }
  const report = await preflight({
    sheetPath,
    sheetName: sheet.sheetName,
    mappingPath,
    productDir,
    giftDir,
    aliases: { ...aliases, ...(loadedRules.sheet?.columns || {}) },
    giftCatalog: loadedRules.gifts?.catalog || [],
  })

  const productFiles = productDir ? await listImages(productDir) : []
  const wanted = Array.isArray(skus) && skus.length ? new Set(skus.map(String)) : null
  const jobs = []
  const skipped = []
  let count = 0
  for (const record of sheet.records || []) {
    const row = normalizeRecord(record.raw || record, { ...aliases, ...(loadedRules.sheet?.columns || {}) })
    if (!row.sku || isNoteRow(row)) continue
    if (wanted && !wanted.has(row.sku)) continue
    if (limit && count >= limit) break
    const mapped = mappingFor(row.sku, mappingTable)
    const job = expandRow(row, mapped, loadedRules)
    if (!job.productFile) job.productFile = exactProductFile(productFiles, job.name)
    job.elements = elementsForJob(job, loadedRules, { giftDir })
    job.productPath = job.productFile && productDir ? path.join(productDir, path.basename(job.productFile)) : job.productFile
    if (!job.productFile) {
      skipped.push({ sku: job.sku, name: job.name, reason: '缺产品图（mapping 未写或文件不存在）' })
      continue
    }
    jobs.push(job)
    count += 1
  }

  return { rules: loadedRules, sheetName: sheet.sheetName, jobs, skipped, preflight: report }
}

export function outputNameFor(job, ext, rules) {
  const template = rules?.export?.filename || '{sku}-{name}.{ext}'
  return sanitizeFilename(filenameFromTemplate(template, { sku: job.sku, name: job.name, ext }))
}
