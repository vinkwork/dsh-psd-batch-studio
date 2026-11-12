/**
 * Explicit asset mapping and preflight. Never silently fuzzy-matches names.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_COLUMN_ALIASES, loadTableFromText, loadTableFromXlsx, normalizeRecord } from './sheet.js'

export const JUNK_NAMES = new Set(['Thumbs.db', '.DS_Store', 'desktop.ini'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

export function isJunkName(name) {
  if (JUNK_NAMES.has(name)) return true
  if (name.startsWith('.')) return true
  return false
}

export function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, '')
    .replace(/pcs|只装|枚|件|套组|联名款/gi, '')
    .replace(/[()（）\[\]【】]/g, '')
    .trim()
}

/** A row with no SKU, or one that holds no digit at all ("说明 …"), is a note, not a product. */
export function isNoteRow(row) {
  return !/\d/.test(String(row?.sku || '').trim())
}

export function isUnset(value) {
  if (value == null) return true
  const text = String(value).trim()
  return text === '' || text === '/'
}

export async function listImages(dir) {
  if (!dir) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (isJunkName(entry.name)) continue
    if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue
    files.push({
      name: entry.name,
      path: path.join(dir, entry.name),
      stem: path.basename(entry.name, path.extname(entry.name)),
    })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function loadMappingTable(filePath) {
  const buffer = await fs.readFile(filePath)
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return loadTableFromXlsx(buffer, { sheetName: '素材映射' })
  }
  return loadTableFromText(buffer.toString('utf8'))
}

export async function loadRequirementSheet(filePath, { sheetName, aliases } = {}) {
  const buffer = await fs.readFile(filePath)
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.csv')) return loadTableFromText(buffer.toString('utf8'), { aliases })
  return loadTableFromXlsx(buffer, { sheetName, aliases })
}

/** Exact name match only (stem === product name). Never fuzzy. Returns the file name or undefined. */
export function exactProductFile(files, name) {
  const key = String(name ?? '').trim()
  if (!key) return undefined
  const hits = files.filter((file) => file.stem === key)
  return hits.length === 1 ? hits[0].name : undefined
}

function fileExistsIn(files, name) {
  if (!name) return null
  const base = path.basename(String(name))
  return files.find((file) => file.name === base) || null
}

function catalogLookup(name, catalog) {
  if (isUnset(name) || !Array.isArray(catalog)) return null
  const raw = String(name).trim()
  const exact = catalog.find((item) => item.name === raw || (item.aliases || []).includes(raw))
  if (exact) return exact
  return null
}

/**
 * @returns structured preflight report. Ambiguous matches are listed, never chosen.
 */
export async function preflight({
  sheetPath,
  sheetName,
  mappingPath,
  productDir,
  giftDir,
  aliases = DEFAULT_COLUMN_ALIASES,
  giftCatalog = [],
} = {}) {
  const products = await listImages(productDir)
  const gifts = await listImages(giftDir)
  const mappingTable = mappingPath ? await loadMappingTable(mappingPath) : { records: [] }
  const sheet = sheetPath ? await loadRequirementSheet(sheetPath, { sheetName, aliases }) : { records: [] }

  const mappingBySku = new Map()
  const mappingIssues = []
  for (const record of mappingTable.records || []) {
    const row = normalizeRecord(record.raw || record, aliases)
    if (!row.sku) continue
    if (mappingBySku.has(row.sku)) {
      mappingIssues.push({ sku: row.sku, kind: 'duplicate_mapping', detail: 'mapping 中 sku 重复' })
    }
    mappingBySku.set(row.sku, row)
  }

  const missingProduct = []
  const missingGift = []
  const ambiguous = []
  const unmappedName = []
  const rows = []

  for (const record of sheet.records || []) {
    const row = normalizeRecord(record.raw || record, aliases)
    if (!row.sku && !row.name) continue
    if (isNoteRow(row)) continue
    const mapped = mappingBySku.get(row.sku) || {}
    const productFile = mapped.productFile || row.productFile || exactProductFile(products, mapped.name || row.name)
    const gift1File = mapped.gift1File || row.gift1File
    const gift2File = mapped.gift2File || row.gift2File
    const item = {
      sku: row.sku,
      name: mapped.name || row.name,
      productFile,
      gift1File,
      gift2File,
      buyGift: row.buyGift,
      fullGift: row.fullGift,
      note: mapped.note || row.note,
    }
    rows.push(item)

    if (!productFile) {
      const key = normalizeKey(item.name)
      const hits = products.filter((file) => normalizeKey(file.stem) === key)
      if (hits.length > 1) {
        ambiguous.push({
          sku: item.sku,
          name: item.name,
          kind: 'product',
          candidates: hits.map((file) => file.name),
        })
      } else if (hits.length === 1) {
        unmappedName.push({
          sku: item.sku,
          name: item.name,
          normalized: key,
          candidate: hits[0].name,
          detail: '仅规范化后与文件名一致（名称不完全相同），禁止静默使用，请改文件名或产品名称',
        })
      } else {
        missingProduct.push({ sku: item.sku, name: item.name, detail: '需求表产品名称在产品图目录里找不到同名文件' })
      }
    } else if (!fileExistsIn(products, productFile)) {
      missingProduct.push({ sku: item.sku, name: item.name, file: productFile, detail: 'mapping.csv 指向的产品图不存在' })
    }

    const giftNames = [row.buyGift, row.fullGift].filter((value) => !isUnset(value))
    const giftFiles = [gift1File, gift2File].filter((value) => !isUnset(value))
    for (const file of giftFiles) {
      if (!fileExistsIn(gifts, file)) {
        missingGift.push({ sku: item.sku, file, detail: 'mapping 指向的赠品图不存在' })
      }
    }
    for (const giftName of giftNames) {
      const cleaned = String(giftName)
        .split(/[，,\n]/)[0]
        .replace(/（.*?）/g, '')
        .trim()
      const hit = catalogLookup(cleaned, giftCatalog)
      if (!hit && giftFiles.length === 0) {
        const key = normalizeKey(cleaned)
        const fuzzy = gifts.filter((file) => normalizeKey(file.stem) === key || key.includes(normalizeKey(file.stem)))
        if (fuzzy.length > 1) {
          ambiguous.push({ sku: item.sku, name: cleaned, kind: 'gift', candidates: fuzzy.map((file) => file.name) })
        } else if (fuzzy.length === 1) {
          unmappedName.push({
            sku: item.sku,
            name: cleaned,
            candidate: fuzzy[0].name,
            detail: '赠品名与文件名规范化后相近，但 catalog/mapping 未写明，禁止静默使用',
          })
        } else {
          missingGift.push({ sku: item.sku, name: cleaned, detail: '需求表里的赠品名在规则的赠品清单（gifts.catalog）里没有，需要补一条' })
        }
      }
    }
  }

  const referenced = new Set()
  for (const item of rows) {
    if (item.productFile) referenced.add(item.productFile)
    if (item.gift1File) referenced.add(item.gift1File)
    if (item.gift2File) referenced.add(item.gift2File)
  }
  for (const entry of giftCatalog) if (entry.file) referenced.add(entry.file)

  const unusedProducts = products.filter((file) => !referenced.has(file.name)).map((file) => file.name)
  const unusedGifts = gifts.filter((file) => !referenced.has(file.name)).map((file) => file.name)

  const junk = []
  for (const dir of [productDir, giftDir]) {
    if (!dir) continue
    let entries = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    for (const name of entries) if (JUNK_NAMES.has(name)) junk.push(path.join(dir, name))
  }

  return {
    sheetName: sheet.sheetName,
    skuCount: rows.length,
    mappingCount: mappingBySku.size,
    rows,
    missingProduct,
    missingGift,
    ambiguous,
    unmappedName,
    unusedProducts,
    unusedGifts,
    junk,
    mappingIssues,
    ok:
      missingProduct.length === 0 &&
      missingGift.length === 0 &&
      ambiguous.length === 0 &&
      unmappedName.length === 0 &&
      // macOS recreates .DS_Store on every Finder visit; list it, don't block on it.
      junk.every((file) => path.basename(String(file)) === '.DS_Store') &&
      mappingIssues.length === 0,
  }
}

export function formatPreflightReport(report) {
  const lines = []
  const section = (title, items, render) => {
    lines.push(`## ${title} (${items.length})`)
    if (!items.length) {
      lines.push('  (none)')
      return
    }
    for (const item of items) lines.push(`  - ${render(item)}`)
  }
  lines.push(`# 预检结果：${report.ok ? '通过，可以出图' : '有问题，先处理再出图'}（需求表共 ${report.skuCount} 个商品）`)
  section('❌ 缺产品图（产品图/ 里没有和「产品名称」同名的文件）', report.missingProduct, (item) => `${item.sku} ${item.name || ''} ${item.file || ''} ${item.detail}`)
  section('❌ 缺赠品图（赠品名在规则的赠品清单里找不到）', report.missingGift, (item) => `${item.sku} ${item.name || item.file || ''} ${item.detail}`)
  section('❌ 多个文件都像（请人工指定，不会自动选）', report.ambiguous, (item) => `${item.sku} ${item.name} → ${item.candidates.join(' | ')}`)
  section('❌ 名字只是相近、不完全相同（请改文件名或产品名称）', report.unmappedName, (item) => `${item.sku} ${item.name} ≈ ${item.candidate}；${item.detail}`)
  section('ℹ️ 没被需求表用到的产品图（仅提示）', report.unusedProducts, (name) => name)
  section('ℹ️ 没被用到的赠品图（仅提示）', report.unusedGifts, (name) => name)
  section('ℹ️ 杂物文件（仅提示）', report.junk, (name) => name)
  section('❌ mapping.csv 问题', report.mappingIssues, (item) => `${item.sku} ${item.detail}`)
  return lines.join('\n')
}
