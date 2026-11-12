import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { preflight } from '../src/core/mapping.js'
import { parseCsv, csvToObjects, parseXlsx } from '../src/core/sheet.js'
import { zipSync } from 'fflate'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-'))
try {
  await fs.mkdir(path.join(dir, '产品图'))
  await fs.mkdir(path.join(dir, '赠品图'))
  await fs.writeFile(path.join(dir, '产品图', '清透柔光蜜粉饼8g.png'), 'x')
  await fs.writeFile(path.join(dir, '产品图', '粉饼8g.png'), 'x')
  await fs.writeFile(path.join(dir, '产品图', 'Thumbs.db'), 'x')
  await fs.writeFile(path.join(dir, '赠品图', '贝果粉扑.png'), 'x')
  await fs.writeFile(
    path.join(dir, 'mapping.csv'),
    'sku,商品名称,产品图文件,赠品1文件,赠品2文件,备注\n1001,清透柔光蜜粉饼8g,清透柔光蜜粉饼8g.png,贝果粉扑.png,,ok\n',
  )
  await fs.writeFile(
    path.join(dir, 'sheet.csv'),
    'sku,商品名称,活动价,买即赠,买2赠,利益点,主商品特点,次商品特点,icon\n1001,清透柔光蜜粉饼8g,85,贝果短绒绒*1,/ ,买1享到手2件礼,控油,0粉感,NEW\n1002,清透柔光蜜粉饼8g+4g,125,/, ,组合装立省25元,, ,NEW\n',
  )

  const report = await preflight({
    sheetPath: path.join(dir, 'sheet.csv'),
    mappingPath: path.join(dir, 'mapping.csv'),
    productDir: path.join(dir, '产品图'),
    giftDir: path.join(dir, '赠品图'),
    giftCatalog: [{ name: '贝果短绒绒*1', file: '贝果粉扑.png' }],
  })
  assert.equal(report.missingProduct.some((item) => item.sku === '1002'), true, 'combo SKU missing art')
  assert.ok(report.unusedProducts.includes('粉饼8g.png'), 'duplicate stem listed as unused, not auto-picked')
  assert.ok(report.junk.some((item) => item.endsWith('Thumbs.db')))
  assert.equal(report.ok, false)

  const rows = parseCsv('a,b\n"1,2",3\n')
  assert.deepEqual(rows[1], ['1,2', '3'])
  const objects = csvToObjects([
    ['sku编码', '产品名称'],
    ['100', '饼'],
  ])
  assert.equal(objects.records[0].sku, '100')
  assert.equal(objects.records[0].name, '饼')

  const encoder = new TextEncoder()
  const xlsx = zipSync({
    '[Content_Types].xml': encoder.encode(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ),
    'xl/workbook.xml': encoder.encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet2" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': encoder.encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': encoder.encode(
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>sku</t></si><si><t>100</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': encoder.encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>',
    ),
  })
  const parsed = parseXlsx(xlsx, { sheetName: 'Sheet2' })
  assert.equal(parsed.grid[0][0], 'sku')
  assert.equal(parsed.grid[1][0], '100')

  console.log('preflight test passed')
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
