/**
 * CSV / XLSX readers used by mapping, preflight and psd_apply_sheet.
 * XLSX support is a minimal shared-strings parser (no extra dependency).
 */
import { unzipSync } from 'fflate'

const SS_NS = /xmlns(?::[^=]+)?="[^"]+"/g

export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      if (row.some((value) => String(value).trim() !== '')) rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }
  if (cell.length || row.length) {
    row.push(cell)
    if (row.some((value) => String(value).trim() !== '')) rows.push(row)
  }
  return rows
}

export function csvToObjects(rows, { aliases = {} } = {}) {
  if (!rows.length) return { headers: [], records: [] }
  const headerIndex = rows.findIndex((row) => row.some((cell) => looksLikeHeader(cell)))
  const at = headerIndex >= 0 ? headerIndex : 0
  const headers = rows[at].map((cell) => String(cell || '').trim())
  const records = []
  for (const row of rows.slice(at + 1)) {
    if (!row.some((cell) => String(cell || '').trim())) continue
    const raw = {}
    headers.forEach((header, index) => {
      if (header) raw[header] = row[index] == null ? '' : String(row[index])
    })
    records.push(normalizeRecord(raw, aliases))
  }
  return { headers, records }
}

function looksLikeHeader(cell) {
  return /^(sku|sku编码|商家编码|商品名称|产品名称|活动价|活动S价)$/i.test(String(cell || '').trim())
}

export const DEFAULT_COLUMN_ALIASES = {
  sku: ['sku编码', 'sku', '商家编码'],
  name: ['产品名称', '商品名称'],
  price: ['活动S价', '活动价'],
  buyGift: ['买即赠'],
  fullGift: ['全店满赠', '买2赠'],
  headline: ['一级卖点文案', '利益点'],
  feature: ['二级卖点文案', '主商品特点'],
  detail: ['三级卖点文案', '次商品特点'],
  icon: ['其他icon', 'icon'],
  productFile: ['产品图文件', '产品图'],
  gift1File: ['赠品1文件', '赠品1'],
  gift2File: ['赠品2文件', '赠品2'],
  note: ['备注'],
}

function pickAliased(raw, names) {
  for (const name of names) {
    if (raw[name] != null && String(raw[name]).trim() !== '') return String(raw[name])
    const key = Object.keys(raw).find((item) => item.trim() === name)
    if (key && String(raw[key]).trim() !== '') return String(raw[key])
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(raw, name)) return String(raw[name] ?? '')
  }
  return ''
}

export function normalizeRecord(raw, aliases = DEFAULT_COLUMN_ALIASES) {
  const map = { ...DEFAULT_COLUMN_ALIASES, ...aliases }
  const record = { raw }
  for (const [field, names] of Object.entries(map)) {
    record[field] = pickAliased(raw, names)
  }
  return record
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes)
}

function cellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(String(ref || ''))
  if (!match) return null
  let col = 0
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(match[2]) - 1 }
}

function parseXmlElements(xml, tag) {
  const out = []
  const re = new RegExp(`<(?:[\\w]+:)?${tag}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w]+:)?${tag}>`, 'g')
  const self = new RegExp(`<(?:[\\w]+:)?${tag}\\b([^>]*)/>`, 'g')
  let match
  while ((match = re.exec(xml))) out.push({ attrs: match[1], body: match[2] })
  while ((match = self.exec(xml))) out.push({ attrs: match[1], body: '' })
  return out
}

function attr(attrs, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attrs || '')
  return match ? match[1] : ''
}

function innerText(xml) {
  const texts = []
  const re = /<(?:[\w]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w]+:)?t>/g
  let match
  while ((match = re.exec(xml))) texts.push(decodeXml(match[1]))
  return texts.join('')
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseSharedStrings(xml) {
  const strings = []
  const re = /<(?:[\w]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w]+:)?si>/g
  let match
  while ((match = re.exec(xml))) strings.push(innerText(match[1]))
  return strings
}

function parseSheetGrid(xml, strings) {
  const rows = new Map()
  let maxCol = -1
  const cells = parseXmlElements(xml.replace(SS_NS, ''), 'c')
  for (const cell of cells) {
    const ref = cellRef(attr(cell.attrs, 'r'))
    if (!ref) continue
    const type = attr(cell.attrs, 't')
    let value = ''
    if (type === 's') {
      const v = /<(?:[\w]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w]+:)?v>/.exec(cell.body)
      value = strings[Number(v ? v[1] : 0)] || ''
    } else if (type === 'inlineStr') {
      value = innerText(cell.body)
    } else {
      const v = /<(?:[\w]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w]+:)?v>/.exec(cell.body)
      value = v ? v[1] : innerText(cell.body)
    }
    if (!rows.has(ref.row)) rows.set(ref.row, new Map())
    rows.get(ref.row).set(ref.col, value)
    if (ref.col > maxCol) maxCol = ref.col
  }
  const maxRow = rows.size ? Math.max(...rows.keys()) : -1
  const grid = []
  for (let row = 0; row <= maxRow; row += 1) {
    const line = []
    const map = rows.get(row) || new Map()
    for (let col = 0; col <= maxCol; col += 1) line.push(map.has(col) ? String(map.get(col)) : '')
    grid.push(line)
  }
  return grid
}

function parseWorkbook(xml) {
  const sheets = []
  const re = /<(?:[\w]+:)?sheet\b([^>]*)\/?>/g
  let match
  while ((match = re.exec(xml))) {
    sheets.push({
      name: decodeXml(attr(match[1], 'name')),
      sheetId: attr(match[1], 'sheetId'),
      state: attr(match[1], 'state') || 'visible',
      rid: attr(match[1], 'r:id') || attr(match[1], 'id'),
    })
  }
  return sheets
}

function parseRels(xml) {
  const map = {}
  const re = /<(?:[\w]+:)?Relationship\b([^>]*)\/?>/g
  let match
  while ((match = re.exec(xml))) {
    const id = attr(match[1], 'Id')
    let target = attr(match[1], 'Target').replace(/^\/+/, '')
    if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\.\//, '')}`
    map[id] = target
  }
  return map
}

export function parseXlsx(buffer, { sheetName } = {}) {
  const files = unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
  const read = (name) => {
    const bytes = files[name] || files[name.replace(/^\//, '')]
    if (!bytes) throw new Error(`XLSX missing ${name}`)
    return decodeUtf8(bytes)
  }
  const workbook = parseWorkbook(read('xl/workbook.xml'))
  const rels = parseRels(read('xl/_rels/workbook.xml.rels'))
  const wanted =
    workbook.find((sheet) => sheet.name === sheetName) ||
    workbook.find((sheet) => sheet.state !== 'hidden') ||
    workbook[0]
  if (!wanted) throw new Error('XLSX has no worksheets')
  const target = rels[wanted.rid]
  if (!target) throw new Error(`XLSX sheet ${wanted.name} has no target`)
  const strings = files['xl/sharedStrings.xml'] ? parseSharedStrings(read('xl/sharedStrings.xml')) : []
  const grid = parseSheetGrid(read(target), strings)
  return { sheetName: wanted.name, sheets: workbook.map((sheet) => sheet.name), grid }
}

export function loadTableFromText(text, options) {
  return csvToObjects(parseCsv(text), options)
}

export function loadTableFromXlsx(buffer, options = {}) {
  const parsed = parseXlsx(buffer, options)
  const table = csvToObjects(parsed.grid, options)
  return { ...table, sheetName: parsed.sheetName, sheets: parsed.sheets }
}

