#!/usr/bin/env node
/**
 * Asset preflight: requirement sheet + mapping + product/gift folders.
 * Never fuzzy-matches. Exit 1 when anything needs a human.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { preflight, formatPreflightReport } from '../src/core/mapping.js'
import { loadRulesFile } from '../src/core/apply-sheet.js'
import { DEFAULT_COLUMN_ALIASES } from '../src/core/sheet.js'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1]
  return fallback
}

async function optionalFile(file) {
  try {
    await fs.access(file)
    return file
  } catch {
    return undefined // mapping.csv is optional: products are matched by exact name
  }
}

const root = path.resolve(arg('root', process.cwd()))
const rulesPath = arg('rules', path.join(root, 'psd文档/template.rules.json'))
let catalog = []
let aliases
let rulesSheetName
try {
  const rules = await loadRulesFile(rulesPath)
  catalog = rules.gifts?.catalog || []
  // Same column mapping the render uses, so the SKUs checked here are the SKUs rendered.
  if (rules.sheet?.columns) aliases = { ...DEFAULT_COLUMN_ALIASES, ...rules.sheet.columns }
  rulesSheetName = rules.sheet?.name
} catch {
  /* rules optional */
}

const report = await preflight({
  sheetPath: arg('sheet', path.join(root, '需求文档.xlsx')),
  sheetName: arg('sheetName', rulesSheetName),
  ...(aliases ? { aliases } : {}),
  mappingPath: await optionalFile(arg('mapping', path.join(root, 'mapping.csv'))),
  productDir: arg('products', path.join(root, '产品图')),
  giftDir: arg('gifts', path.join(root, '赠品图')),
  giftCatalog: catalog,
})

const text = formatPreflightReport(report)
console.log(text)
const out = arg('out')
if (out) await fs.writeFile(out, text)

process.exit(report.ok ? 0 : 1)
