/**
 * Post-render checks that replace the hard-coded Python pixel script.
 */
import { loadImage } from '@napi-rs/canvas'
import { collectOverrideFonts } from './rules.js'

function rectFromBounds(bounds) {
  if (!bounds) return null
  if (Array.isArray(bounds) && bounds.length >= 4) {
    const [x0, y0, x1, y1] = bounds.map(Number)
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
  }
  if (bounds.w != null) return { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, w: Number(bounds.w), h: Number(bounds.h) }
  return null
}

function containsRect(outer, inner, pad = 2) {
  if (!outer || !inner) return false
  return (
    inner.x >= outer.x - pad &&
    inner.y >= outer.y - pad &&
    inner.x + inner.w <= outer.x + outer.w + pad &&
    inner.y + inner.h <= outer.y + outer.h + pad
  )
}

function countColor(imageData, { r, g, b, tol = 45 }) {
  const data = imageData.data
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (
      Math.abs(data[index] - r) < tol &&
      Math.abs(data[index + 1] - g) < tol &&
      Math.abs(data[index + 2] - b) < tol &&
      data[index + 3] > 8
    ) {
      count += 1
    }
  }
  return count
}

function cropStats(ctx, rect) {
  if (!rect || rect.w < 1 || rect.h < 1) return { mean: 0, std: 0, pixels: 0 }
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.max(1, Math.floor(rect.w))
  const h = Math.max(1, Math.floor(rect.h))
  let data
  try {
    data = ctx.getImageData(x, y, w, h).data
  } catch {
    return { mean: 0, std: 0, pixels: 0 }
  }
  let sum = 0
  let sum2 = 0
  const n = w * h
  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] + data[i + 1] + data[i + 2]) / 3
    sum += luma
    sum2 += luma * luma
  }
  const mean = sum / n
  const variance = Math.max(0, sum2 / n - mean * mean)
  return { mean, std: Math.sqrt(variance), pixels: n }
}

/**
 * @param {object} input
 * @param {string} input.imagePath rendered file
 * @param {object} input.job expandRow result
 * @param {object} [input.inspect] layer inspect after overrides
 * @param {object} [input.scene] buildScene result
 * @param {string[]} [input.missingFonts]
 * @param {object} [input.rules]
 */
export async function validateSku(input) {
  const checks = []
  const pass = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: detail || '' })

  const job = input.job || {}
  for (const item of job.texts || []) {
    const layer = (input.inspect?.layers || []).find(
      (entry) => entry.name === item.layer || entry.fullName === item.layer || entry.leafId === item.layer,
    )
    if (item.value != null) {
      if (!layer) pass('text_written', false, `层不存在: ${item.layer}`)
      else pass('text_written', layer.textContent === item.value, `${item.layer} → ${JSON.stringify(layer.textContent)}`)
    }
    if (layer?.runs) {
      for (const run of layer.runs) {
        if (run.family && input.registered && !input.registered.has(run.family)) {
          pass('font_registered', false, `${layer.name} ${run.family}`)
        }
      }
    }
  }

  // Missing fonts block only when the batch was strict; otherwise the render
  // fell back on purpose and this is a warning, not a failure.
  const missing = input.missingFonts || []
  if (missing.length && input.strictFonts === false) {
    checks.push({ id: 'font_registered', ok: true, warn: true, detail: `已回退：${missing.join(', ')}` })
  } else {
    pass('font_registered', missing.length === 0, missing.length ? missing.join(', ') : 'ok')
  }

  for (const spec of job.visibility || []) {
    const layer = (input.inspect?.layers || []).find(
      (entry) => entry.name === spec.layer || entry.fullName === spec.layer,
    )
    if (!layer) {
      pass('visibility', false, `层不存在: ${spec.layer}`)
      continue
    }
    const hidden = spec.hidden !== false
    pass('visibility', layer.visible !== hidden, `${spec.layer} visible=${layer.visible} expected hidden=${hidden}`)
  }

  const containers = input.rules?.containers || {}
  for (const item of job.texts || []) {
    const layer = (input.inspect?.layers || []).find(
      (entry) => entry.name === item.layer || entry.fullName === item.layer,
    )
    const box = containers[item.layer] || (item.containerKey && containers[item.containerKey])
    if (!layer?.bounds || !box) continue
    const inner = rectFromBounds(layer.bounds)
    const outer = rectFromBounds(box)
    pass('bbox', containsRect(outer, inner, 8), `${item.layer} ${JSON.stringify(inner)} vs ${JSON.stringify(outer)}`)
  }

  const giftSlots = input.rules?.gifts?.slots || []
  const placed = input.placedElements || []
  giftSlots.forEach((slot, index) => {
    const gift = (job.gifts || [])[index]
    if (!gift || !gift.files?.length) return
    const anchor = rectFromBounds(slot.anchor?.bounds || slot.bounds)
    const hits = placed.filter((element) => element.slot === slot.id || element.slot === ['upper', 'lower'][index])
    if (!hits.length) {
      pass('gift_anchor', false, `${slot.id || index} 没有置入`)
      return
    }
    for (const element of hits) {
      if (element.left == null || element.w == null) {
        pass('gift_anchor', true, `${element.name || slot.id} planned`)
        continue
      }
      const box = { x: element.left, y: element.top, w: element.w, h: element.h }
      pass('gift_anchor', containsRect(anchor, box, 24), `${element.name} in ${slot.id}`)
    }
  })

  if (input.scene?.slots) {
    pass('single_product', input.scene.slots.length === 1, `slots=${input.scene.slots.length}`)
  }

  let imageCheck = null
  if (input.imagePath) {
    try {
      const image = await loadImage(input.imagePath)
      const { createCanvas } = await import('@napi-rs/canvas')
      const canvas = createCanvas(image.width, image.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const priceBox = rectFromBounds(input.rules?.validate?.priceRegion || input.rules?.containers?.price_value)
      if (priceBox) {
        const x = Math.max(0, Math.floor(priceBox.x))
        const y = Math.max(0, Math.floor(priceBox.y))
        const data = ctx.getImageData(x, y, Math.max(1, Math.floor(priceBox.w)), Math.max(1, Math.floor(priceBox.h)))
        const red = input.rules?.validate?.priceRed || { r: 204, g: 48, b: 70, tol: 45 }
        const count = countColor(data, red)
        pass('price_red', count > 0, `红字像素 ${count}`)
        imageCheck = { priceRed: count }
      }
      const productBox = rectFromBounds(input.rules?.validate?.productRegion)
      if (productBox) {
        const stats = cropStats(ctx, productBox)
        const maxStd = input.rules?.validate?.productStdMax
        pass('product_region', maxStd == null || stats.std <= maxStd, `std=${stats.std.toFixed(1)}`)
        imageCheck = { ...(imageCheck || {}), productStd: stats.std }
      }
    } catch (error) {
      pass('image', false, error.message || String(error))
    }
  }

  const failed = checks.filter((item) => !item.ok)
  return {
    sku: job.sku,
    ok: failed.length === 0,
    checks,
    failed: failed.map((item) => item.id),
    fonts: collectOverrideFonts(job.texts),
    image: imageCheck,
  }
}

export function summarizeValidation(reports) {
  const failed = reports.filter((item) => !item.ok)
  return {
    count: reports.length,
    passed: reports.length - failed.length,
    failed: failed.map((item) => item.sku),
    reports,
  }
}
