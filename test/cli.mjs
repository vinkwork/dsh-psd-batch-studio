/**
 * CLI contract: bin/psd-engine.mjs prints JSON and exits 0 / 1 / 2.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { writePsd } from 'ag-psd'

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'psd-engine.mjs')

function fill(width, height, color) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas
}

const run = (cwd, args, input) => spawnSync(process.execPath, [bin, ...args], { cwd, input, encoding: 'utf8' })

const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'psd-engine-cli-')))
try {
  const psd = writePsd({
    width: 200,
    height: 200,
    children: [
      { name: 'bg', left: 0, top: 0, right: 200, bottom: 200, canvas: fill(200, 200, '#eeeeee') },
      { name: 'slot', left: 50, top: 50, right: 150, bottom: 150, canvas: fill(100, 100, '#0000cc') },
      {
        name: 'title',
        left: 10,
        top: 160,
        right: 190,
        bottom: 190,
        canvas: fill(180, 30, '#000000'),
        text: { text: 'Hello', transform: [1, 0, 0, 1, 10, 160], style: { font: { name: 'ArialMT' }, fontSize: 24 } },
      },
    ],
  })
  await fs.writeFile(path.join(dir, 't.psd'), Buffer.from(psd))
  await fs.writeFile(path.join(dir, 'p.png'), await fill(40, 60, '#cc0000').encode('png'))

  const inspected = run(dir, ['inspect', 't.psd'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const info = JSON.parse(inspected.stdout)
  assert.equal(info.width, 200)
  const title = info.layers.find((layer) => layer.name === 'title')
  assert.equal(title.textContent, 'Hello')

  const spec = { template: 't.psd', outDir: 'out', format: 'png', jobs: [{ name: 'one', product: 'p.png', slots: ['slot'], text: [{ layer: title.id, value: 'Bye' }] }] }
  const rendered = run(dir, ['render', '-'], JSON.stringify(spec))
  assert.equal(rendered.status, 0, rendered.stderr)
  const result = JSON.parse(rendered.stdout)
  assert.equal(result.count, 1)
  await fs.access(path.join(dir, 'out', 'one.png'))

  const partial = run(dir, ['render', '-'], JSON.stringify({ ...spec, jobs: [...spec.jobs, { name: 'bad', product: 'nope.png' }] }))
  assert.equal(partial.status, 2, 'some jobs failed → exit 2')

  const viewed = run(dir, ['view', 'out/one.png', '--crop', '0,150,200,200', '--scale', '2', '--grid'])
  assert.equal(viewed.status, 0, viewed.stderr)
  await fs.access(path.join(dir, JSON.parse(viewed.stdout).file))

  const checked = run(dir, ['check', 't.psd'])
  assert.equal(checked.status, 0, checked.stderr)
  assert.ok(JSON.parse(checked.stdout).rows.length === 1)

  // Free-text names keep their dots; a default output folder is never reused.
  const dotted = { template: 't.psd', format: 'png', jobs: [{ name: '售价19.9元' }] }
  const first = JSON.parse(run(dir, ['render', '-'], JSON.stringify(dotted)).stdout)
  const second = JSON.parse(run(dir, ['render', '-'], JSON.stringify(dotted)).stdout)
  assert.equal(first.jobs[0].file, '售价19.9元.png')
  assert.notEqual(first.outDir, second.outDir, 'each batch writes to its own folder')

  assert.equal(run(dir, ['inspect', 'missing.psd']).status, 1)
  console.log('cli test passed')
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
