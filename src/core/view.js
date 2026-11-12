/**
 * Inspection view: crop + zoom a rendered image and draw labelled rectangles
 * and a coordinate grid on it, so an agent (or a person) can read exact pixel
 * positions off the picture instead of guessing from a thumbnail.
 *
 * Pure drawing: the caller supplies a loaded image and plain rectangles in the
 * IMAGE's pixel space, and gets a canvas back.
 */
import { createCanvas as makeCanvas } from './canvas.js'

const LABEL_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const PALETTE = ['#ff2d55', '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#00c7be']

/** Normalise [x0,y0,x1,y1] or {x,y,w,h} to {x,y,w,h}; null when unusable. */
export function toRect(value) {
  if (!value) return null
  if (Array.isArray(value) && value.length >= 4) {
    const [x0, y0, x1, y1] = value.map(Number)
    if ([x0, y0, x1, y1].some((n) => !Number.isFinite(n))) return null
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
  }
  if (typeof value === 'object' && value.w != null) {
    const { x, y, w, h } = value
    if ([x, y, w, h].some((n) => !Number.isFinite(Number(n)))) return null
    return { x: Number(x), y: Number(y), w: Number(w), h: Number(h) }
  }
  return null
}

/** Clamp a crop to the image; falls back to the whole image. */
export function resolveCrop(crop, width, height) {
  const rect = toRect(crop)
  if (!rect || rect.w < 1 || rect.h < 1) return { x: 0, y: 0, w: width, h: height }
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)))
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)))
  const w = Math.max(1, Math.min(width - x, Math.round(rect.w)))
  const h = Math.max(1, Math.min(height - y, Math.round(rect.h)))
  return { x, y, w, h }
}

/** Zoom so the crop fills `maxWidth`, never shrinking below 1 and capped at 16×. */
export function resolveScale(scale, crop, maxWidth = 1600) {
  const wanted = Number(scale)
  if (Number.isFinite(wanted) && wanted > 0) return Math.min(16, wanted)
  return Math.max(1, Math.min(16, Math.floor((maxWidth / crop.w) * 100) / 100))
}

function niceStep(visiblePx) {
  // Aim for roughly 8 grid lines across the crop.
  const raw = visiblePx / 8
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (step >= raw) return step
  return 500
}

/**
 * @param {object} options
 * @param {*} options.image drawable image
 * @param {number[]|object} [options.crop] region in image px
 * @param {number} [options.scale] zoom factor (auto when omitted)
 * @param {Array<{rect: any, label?: string, color?: string}>} [options.rects]
 * @param {boolean|number} [options.grid] draw a coordinate grid (true = auto step, number = step in px)
 * @returns {{canvas: object, crop: object, scale: number, rects: object[]}}
 */
export function renderView({ image, crop, scale, rects = [], grid = false, maxWidth = 1600 }) {
  const region = resolveCrop(crop, image.width, image.height)
  const factor = resolveScale(scale, region, maxWidth)
  const width = Math.max(1, Math.round(region.w * factor))
  const height = Math.max(1, Math.round(region.h * factor))
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = factor < 3
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, width, height)

  const toView = (rect) => ({
    x: (rect.x - region.x) * factor,
    y: (rect.y - region.y) * factor,
    w: rect.w * factor,
    h: rect.h * factor,
  })

  if (grid) {
    const step = typeof grid === 'number' && grid > 0 ? grid : niceStep(region.w)
    ctx.save()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0,255,255,0.45)'
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.font = `${Math.max(10, Math.min(14, 11 + factor))}px sans-serif`
    ctx.textBaseline = 'top'
    const label = (text, x, y) => {
      const w = ctx.measureText(text).width + 4
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(x, y, w, 14)
      ctx.fillStyle = '#7ff'
      ctx.fillText(text, x + 2, y + 1)
    }
    const firstX = Math.ceil(region.x / step) * step
    for (let x = firstX; x < region.x + region.w; x += step) {
      const vx = Math.round((x - region.x) * factor) + 0.5
      ctx.beginPath()
      ctx.moveTo(vx, 0)
      ctx.lineTo(vx, height)
      ctx.stroke()
      label(String(x), vx + 1, 1)
    }
    const firstY = Math.ceil(region.y / step) * step
    for (let y = firstY; y < region.y + region.h; y += step) {
      const vy = Math.round((y - region.y) * factor) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, vy)
      ctx.lineTo(width, vy)
      ctx.stroke()
      label(String(y), 1, vy + 1)
    }
    ctx.restore()
  }

  const drawn = []
  rects.forEach((item, index) => {
    const rect = toRect(item.rect)
    if (!rect) return
    const color = item.color || PALETTE[index % PALETTE.length]
    const view = toView(rect)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(view.x, view.y, view.w, view.h)
    if (item.label) {
      ctx.font = `12px ${LABEL_FONT}`
      ctx.textBaseline = 'top'
      // Canvas fonts may lack CJK glyphs; draw a number and let the caller map it back.
      const text = /[^\x00-\x7f]/.test(String(item.label)) ? `#${index + 1}` : String(item.label)
      const w = ctx.measureText(text).width + 6
      const above = view.y >= 16
      const ty = above ? view.y - 16 : view.y + 1
      ctx.fillStyle = color
      ctx.fillRect(view.x, ty, w, 15)
      ctx.fillStyle = '#fff'
      ctx.fillText(text, view.x + 3, ty + 1)
    }
    ctx.restore()
    drawn.push({ label: item.label ? `#${index + 1} ${item.label}` : `#${index + 1}`, rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h] })
  })

  return { canvas, crop: region, scale: factor, rects: drawn }
}
