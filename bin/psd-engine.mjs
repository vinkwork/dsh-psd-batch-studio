#!/usr/bin/env node
/**
 * Command-line shell over src/engine.js. Prints JSON on stdout; paths are
 * relative to the current directory. Exit code: 0 ok, 1 error, 2 some jobs failed.
 *
 *   psd-engine inspect <template> [--fonts <dir>]
 *   psd-engine render  <spec.json | ->            spec = {template, jobs, defaults?, outDir?, format?, quality?, fonts?, strictFonts?}
 *   psd-engine view    <image> [--crop x0,y0,x1,y1] [--scale 2] [--grid [step]] [--out file.png]
 *   psd-engine check   <template> [--layers a,b] [--fonts <dir>]
 */
import fs from 'node:fs/promises'
import { inspect, render, view, checkText } from '../src/engine.js'

const USAGE = `usage:
  psd-engine inspect <template> [--fonts <dir>]
  psd-engine render  <spec.json | ->
  psd-engine view    <image> [--crop x0,y0,x1,y1] [--scale n] [--grid [step]] [--out file.png]
  psd-engine check   <template> [--layers a,b] [--fonts <dir>]`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      index += 1
    }
  }
  return { positional, flags }
}

const numbers = (value) => String(value).split(',').map(Number)
const list = (value) => (value == null || value === true ? undefined : String(value).split(',').map((item) => item.trim()).filter(Boolean))

async function readSpec(source) {
  if (!source) throw new Error('render needs a spec file (or - for stdin)')
  if (source === '-') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  return JSON.parse(await fs.readFile(source, 'utf8'))
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  switch (command) {
    case 'inspect':
      return inspect({ template: positional[0], fonts: list(flags.fonts) })
    case 'render': {
      const spec = await readSpec(positional[0])
      return render({ ...spec, root: undefined, confine: false })
    }
    case 'view':
      return view({
        image: positional[0],
        out: flags.out,
        crop: flags.crop ? numbers(flags.crop) : undefined,
        scale: flags.scale ? Number(flags.scale) : undefined,
        grid: flags.grid === true ? true : flags.grid ? Number(flags.grid) : false,
      })
    case 'check':
      return checkText({ template: positional[0], layers: list(flags.layers), fonts: list(flags.fonts) })
    default:
      process.stderr.write(`${USAGE}\n`)
      process.exit(command && command !== 'help' ? 1 : 0)
  }
}

try {
  const result = await main()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result && result.failed > 0) process.exitCode = 2
} catch (error) {
  process.stderr.write(`error: ${error?.message || error}\n`)
  process.exitCode = 1
}
