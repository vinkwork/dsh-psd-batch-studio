#!/usr/bin/env node
/**
 * 命令行入口：不依赖任何宿主，DeepSeek Harness / Claude Code / 手动终端都能用。
 * 在项目根目录运行：  node 引擎/bin/psd.mjs <命令> --case <案例名> [参数]
 * 命令： preflight | draft | render | view | check | tool
 * 案例名 = 各分类文件夹（模板/规则/需求表/产品图/赠品图/字体包/说明图/输出）下的同名子文件夹，例如「示范案例」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.PSD_ROOT ? path.resolve(process.env.PSD_ROOT) : path.resolve(ENGINE, '..')

const argv = process.argv.slice(2)
const command = argv.shift()
const flags = {}
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else { flags[key] = next; i++ }
  } else rest.push(a)
}

const HELP = `用法（在项目根目录运行；每条命令都带 --case 案例名，例如 --case 示范案例。只有一个案例时可省略）：
  node 引擎/bin/psd.mjs preflight --case 示范案例                    预检：缺图、对不上的名字
  node 引擎/bin/psd.mjs draft --case 示范案例 [--template 模板/示范案例/X.psb] [--overwrite]
                                                                      只看模板，起草规则
  node 引擎/bin/psd.mjs render --case 示范案例 [--limit 2] [--skus a,b] [--format jpg|png|webp]
                               [--strict-fonts]                       出图（--limit 2 = 样张）
  node 引擎/bin/psd.mjs view --case 示范案例 --image 图.jpg [--crop x0,y0,x1,y1] [--scale 2] [--grid 100]
  node 引擎/bin/psd.mjs view --case 示范案例 --image 图.jpg --template 模板/示范案例/X.psb --text-layers
  node 引擎/bin/psd.mjs check --case 示范案例                         文字层重绘对照
  node 引擎/bin/psd.mjs tool <工具名> '<JSON 参数>'                     直接调用任意工具
案例文件夹约定：
  模板/<案例>/X.psb   规则/<案例>/X.rules.json   需求表/<案例>/需求表.xlsx
  产品图/<案例>/      赠品图/<案例>/              字体包/<案例>/（没有就用 字体包/ 根目录）
  说明图/<案例>/      输出/<案例>/<自动命名>/
可用 --rules / --sheet / --template 指向别的案例的文件（例如多个活动共用一个模板）。`

if (!command || command === 'help' || flags.help) {
  console.log(HELP)
  process.exit(0)
}

const rel = (p) => (p ? path.relative(ROOT, path.resolve(ROOT, String(p))) : p)
const nums = (s) => String(s).split(',').map(Number)
const exists = (p) => fs.existsSync(path.resolve(ROOT, p))
const SECTIONS = ['模板', '规则', '需求表', '产品图', '赠品图', '字体包', '说明图', '输出']

function fail(msg) {
  console.error('出错了：' + msg)
  process.exit(1)
}
function listDirs(dir) {
  const abs = path.join(ROOT, dir)
  return fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name) : []
}
function resolveCase() {
  if (flags.case && flags.case !== true) return String(flags.case)
  const all = [...new Set(['产品图', '需求表', '模板'].flatMap(listDirs))]
  if (all.length === 1) return all[0]
  fail(`请用 --case 指定案例名。现有案例：${all.join('、') || '（还没有）'}`)
}
const CASE = ['help', 'tool'].includes(command) ? undefined : resolveCase()
if (CASE) {
  const have = [...new Set(['产品图', '需求表', '模板'].flatMap(listDirs))]
  if (!have.includes(CASE)) fail(`没有「${CASE}」这个案例。现有案例：${have.join('、') || '（还没有）'}。新案例需要在 模板、规则、需求表、产品图、赠品图 等文件夹下各建一个同名子文件夹`)
}
const inCase = (section) => `${section}/${CASE}`
function filesIn(dir, re) {
  const abs = path.join(ROOT, dir)
  return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => re.test(f) && !f.startsWith('~$') && !f.startsWith('.')) : []
}
function oneOf(dir, re, what) {
  const list = filesIn(dir, re)
  if (list.length > 1) throw new Error(`${dir}/ 里有 ${list.length} 个${what}（${list.join('、')}），请指定用哪一个`)
  return list.length ? `${dir}/${list[0]}` : undefined
}
function firstRules() {
  return oneOf(inCase('规则'), /\.rules\.json$/, '规则文件')
}
function sheetPath() {
  if (flags.sheet) return rel(flags.sheet)
  const dir = inCase('需求表')
  if (exists(`${dir}/需求表.xlsx`)) return `${dir}/需求表.xlsx`
  return oneOf(dir, /\.(xlsx|csv)$/i, '需求表') || `${dir}/需求表.xlsx`
}
function templateFile() {
  return oneOf(inCase('模板'), /\.(psd|psb)$/i, '模板文件')
}
function fontDir() {
  return exists(inCase('字体包')) ? inCase('字体包') : '字体包'
}
function mappingPath() {
  if (flags.mapping) return rel(flags.mapping)
  return exists(`${inCase('需求表')}/mapping.csv`) ? `${inCase('需求表')}/mapping.csv` : undefined
}

const { registerTools } = await import(path.join(ENGINE, 'src/server.js'))
const tools = new Map()
registerTools({ reflect: { get: () => undefined }, tools: { register: (def) => (tools.set(def.name, def), () => {}) } })
const exec = { agent: { session: { header: { cwd: ROOT } } } }

async function run(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`没有这个工具：${name}。可用：${[...tools.keys()].join(', ')}`)
  const value = await tool.execute(args, exec)
  return { tool, value, text: tool.output.render(args, value).map((x) => x.text).join('\n') }
}

try {
  if (command === 'preflight') {
    const { preflight, formatPreflightReport } = await import(path.join(ENGINE, 'src/core/mapping.js'))
    const { loadRulesFile } = await import(path.join(ENGINE, 'src/core/apply-sheet.js'))
    const { DEFAULT_COLUMN_ALIASES } = await import(path.join(ENGINE, 'src/core/sheet.js'))
    const rulesFile = flags.rules ? rel(flags.rules) : firstRules()
    let rules = {}
    if (rulesFile && exists(rulesFile)) rules = await loadRulesFile(path.resolve(ROOT, rulesFile))
    const report = await preflight({
      sheetPath: path.resolve(ROOT, sheetPath()),
      sheetName: flags.sheetName || rules.sheet?.name,
      aliases: { ...DEFAULT_COLUMN_ALIASES, ...(rules.sheet?.columns || {}) },
      mappingPath: mappingPath() ? path.resolve(ROOT, mappingPath()) : undefined,
      productDir: path.resolve(ROOT, inCase('产品图')),
      giftDir: path.resolve(ROOT, inCase('赠品图')),
      giftCatalog: rules.gifts?.catalog || [],
    })
    console.log(formatPreflightReport(report))
    process.exit(report.ok ? 0 : 1)
  } else if (command === 'draft') {
    const template = flags.template ? rel(flags.template) : templateFile()
    if (!template) throw new Error(`${inCase('模板')}/ 里还没有模板文件（.psd / .psb）`)
    const base = path.basename(template).replace(/\.(psd|psb)$/i, '')
    const out = flags.out ? rel(flags.out) : `${inCase('规则')}/${base}.rules.json`
    const { text, value } = await run('psd_draft_rules', {
      template,
      giftDir: inCase('赠品图'),
      ...(flags.sheetName ? { sheetName: flags.sheetName } : {}),
      outRules: out,
      overwrite: !!flags.overwrite,
    })
    console.log(text)
    console.log(JSON.stringify({ written: value.written, unresolved: value.unresolved }, null, 1))
  } else if (command === 'render') {
    const rules = flags.rules ? rel(flags.rules) : firstRules()
    if (!rules) throw new Error(`${inCase('规则')}/ 里还没有规则文件。先起草规则（draft），或用 --rules 指定别的案例的规则`)
    const limit = flags.limit ? Number(flags.limit) : undefined
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    const outDir = flags.out ? rel(flags.out) : `${inCase('输出')}/${limit ? '样张' : '批量'}-${stamp}`
    const args = {
      sheet: sheetPath(),
      rules,
      ...(flags.template ? { template: rel(flags.template) } : {}),
      productDir: inCase('产品图'),
      giftDir: inCase('赠品图'),
      fontDir: fontDir(),
      outDir,
      format: flags.format || 'jpg',
      quality: 95,
      validate: true,
      contactSheet: true,
      strictFonts: !!flags['strict-fonts'],
      ...(mappingPath() ? { mapping: mappingPath() } : {}),
      ...(flags.sheetName ? { sheetName: flags.sheetName } : {}),
      ...(limit ? { limit } : {}),
      ...(flags.skus ? { skus: String(flags.skus).split(',').map((s) => s.trim()) } : {}),
    }
    if (!args.template) {
      const r = JSON.parse(fs.readFileSync(path.resolve(ROOT, rules), 'utf8'))
      args.template = templateFile() || (r.template && exists(r.template) ? r.template : undefined)
    }
    const { value, text } = await run('psd_apply_sheet', args)
    console.log(text.split('\n').slice(0, 3).join('\n'))
    const failed = value.failed || []
    const skipped = value.skipped || []
    if (failed.length) console.log('失败：\n' + JSON.stringify(failed, null, 1))
    if (skipped.length) console.log('跳过：\n' + JSON.stringify(skipped, null, 1))
    const reportFile = path.join(ROOT, outDir, 'report.json')
    if (fs.existsSync(reportFile)) console.log(`详细报告：${path.join(outDir, 'report.json')}`)
    process.exit(failed.length ? 1 : 0)
  } else if (command === 'view') {
    const args = {
      image: flags.image ? rel(flags.image) : flags.template ? rel(flags.template) : undefined,
      ...(flags.crop ? { crop: nums(flags.crop) } : {}),
      ...(flags.scale ? { scale: Number(flags.scale) } : {}),
      ...(flags.grid ? { grid: flags.grid === true ? -1 : Number(flags.grid) } : {}),
      ...(flags.template ? { template: rel(flags.template) } : {}),
      ...(flags['text-layers'] ? { textLayers: true } : {}),
      ...(flags.layers ? { layers: String(flags.layers).split(',') } : {}),
      outDir: flags.out ? rel(flags.out) : `${inCase('输出')}/_查看`,
    }
    if (flags.template && !flags.image) {
      // 模板没有现成预览图时，先让工具自己渲染不了：提示用法
      console.error('提示：--template 配合 --image（先出的样张）一起用，才能在图上画出文字层。')
    }
    const { text } = await run('psd_view', args)
    console.log(text)
  } else if (command === 'check') {
    const template = flags.template ? rel(flags.template) : templateFile()
    if (!template) throw new Error(`${inCase('模板')}/ 里还没有模板文件`)
    const { text } = await run('psd_text_check', { template, fontDir: fontDir() })
    console.log(text)
  } else if (command === 'tool') {
    const name = rest[0]
    const args = rest[1] ? JSON.parse(rest[1]) : {}
    const { text } = await run(name, args)
    console.log(text)
  } else {
    console.log(HELP)
    process.exit(2)
  }
} catch (error) {
  console.error('出错了：' + (error?.message || error))
  process.exit(1)
}
