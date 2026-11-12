/**
 * Text engine self-calibration.
 *
 * Re-render every text layer with its ORIGINAL copy through the same engine
 * that rewrites text, then compare the ink bounds with the pixels Photoshop
 * rasterized. Any gap is the engine disagreeing with Photoshop (size, baseline,
 * tracking, missing font), measured without needing a reference render.
 */
import { createCanvas as makeCanvas } from './canvas.js'
import { restoreTextLeaf, synthesizeTextLeaf } from './text.js'

/** Tight alpha bounds [x0, y0, x1, y1] of a canvas, or null when empty. */
export function inkBounds(canvas, threshold = 40) {
  if (!canvas || canvas.width < 1 || canvas.height < 1) return null
  const { width, height } = canvas
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1]
}

const round = (value) => Math.round(value * 100) / 100

/**
 * @param {object} doc parsed template document (leaves are restored afterwards)
 * @param {(family: string) => boolean} hasFont font availability probe
 * @param {{layers?: string[]}} [options] limit to these layer names / paths
 * @returns {Array<object>} one row per text layer
 */
export function calibrateText(doc, hasFont, { layers } = {}) {
  const wanted = layers && layers.length ? new Set(layers.map(String)) : null
  const rows = []
  for (const entry of doc.entries) {
    if (!entry.text || !entry.leafId) continue
    if (wanted && !wanted.has(entry.name) && !wanted.has(entry.fullName) && !wanted.has(entry.id)) continue
    const leaf = doc.leaves.find((item) => item.id === entry.leafId)
    if (!leaf) continue
    const row = { layer: entry.fullName || entry.name, text: entry.text.value.slice(0, 24) }
    const original = leaf.__raster || { canvas: leaf.canvas, left: leaf.left, top: leaf.top }
    const before = inkBounds(original.canvas)
    if (!before) {
      rows.push({ ...row, ok: false, note: '原图层没有像素' })
      continue
    }
    const orig = [before[0] + original.left, before[1] + original.top, before[2] + original.left, before[3] + original.top]

    if (!leaf.__raster) leaf.__raster = { canvas: leaf.canvas, left: leaf.left, top: leaf.top, width: leaf.width, height: leaf.height }
    else restoreTextLeaf(leaf)
    try {
      const warnings = synthesizeTextLeaf(leaf, entry.text, { value: entry.text.value, dx: 0 }, hasFont)
      const after = inkBounds(leaf.canvas)
      if (!after) {
        rows.push({ ...row, ok: false, note: '重绘后没有像素', warnings })
        continue
      }
      const re = [after[0] + leaf.left, after[1] + leaf.top, after[2] + leaf.left, after[3] + leaf.top]
      const ow = orig[2] - orig[0]
      const oh = orig[3] - orig[1]
      const rw = re[2] - re[0]
      const rh = re[3] - re[1]
      rows.push({
        ...row,
        ok: true,
        orig,
        rendered: re,
        widthRatio: round(rw / ow),
        heightRatio: round(rh / oh),
        // Centre offsets: positive dx = engine draws to the right, dy = lower.
        dx: round((re[0] + re[2]) / 2 - (orig[0] + orig[2]) / 2),
        dy: round((re[1] + re[3]) / 2 - (orig[1] + orig[3]) / 2),
        // Top and bottom edge gaps separate "wrong size" from "wrong baseline".
        topGap: re[1] - orig[1],
        bottomGap: re[3] - orig[3],
        warnings,
      })
    } catch (error) {
      rows.push({ ...row, ok: false, note: `重绘失败：${error?.message || error}` })
    } finally {
      restoreTextLeaf(leaf)
    }
  }
  return rows
}

export { makeCanvas }
