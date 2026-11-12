/**
 * Draft a template.rules.json from a parsed PSD alone.
 *
 * Every tag comes with the evidence it was based on (group name, copy pattern,
 * or geometry) so a person or agent can audit it, and anything that could not
 * be decided is listed in `unresolved` instead of being guessed. What a PSD
 * cannot say (copy hierarchy such as "empty headline promotes the sub-head",
 * gift tiers that are not drawn in the template) still has to come from the
 * modification note.
 */
import { charStyles } from './text.js'
import { DEFAULT_COLUMN_ALIASES } from './sheet.js'

const ROLE_GROUPS = [
  ['headline', /一级|主标|利益点|headline|title/i],
  ['subhead', /二级|副标|subhead|sub/i],
  ['detail', /三级|detail|短句/i],
  ['product_name', /产品名|商品名|品名|product.?name/i],
]
const GIFT_TITLE = /^\s*(买即赠|满\s*\d+\s*(?:元)?\s*(?:送|赠)|买\s*\d+\s*(?:送|赠))\s*$/
const NUMBER = /^\s*[¥￥$]?\s*\d+(?:\.\d+)?\s*$/
const round = (value, digits = 0) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const hex = (color) => `#${(color || [0, 0, 0]).slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`
const hasCjk = (text) => /[㐀-鿿]/.test(text)

function rectOf(entry) {
  const [x0, y0, x1, y1] = entry.bounds
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

function textInfo(entry) {
  const text = entry.text
  const scale = text.scale > 0 ? text.scale : 1
  const sizes = (text.runs || []).map((run) => (run.size || 0) * scale).filter((n) => n > 0)
  return { scale, px: sizes.length ? Math.max(...sizes) : 0, run: text.runs?.[0] || {} }
}

/** Split a copy string into digit characters vs the rest, with their styles. */
function digitSplit(entry) {
  const chars = charStyles(entry.text.runs || [], entry.text.value)
  const scale = entry.text.scale > 0 ? entry.text.scale : 1
  const pick = (test) => {
    const found = chars.find((style, index) => test(entry.text.value[index] || ''))
    return found
      ? { family: found.family, sizePx: round((found.size || 0) * scale), color: hex(found.color) }
      : null
  }
  return { digit: pick((ch) => /\d/.test(ch)), text: pick((ch) => !/[\d\s]/.test(ch)) }
}

export function draftRules(doc, { giftFiles = [], sheetName, templateName, sample } = {}) {
  const byId = new Map(doc.entries.map((entry) => [entry.id, entry]))
  const ancestors = (entry) => {
    const names = []
    let parent = entry.parentId ? byId.get(entry.parentId) : null
    while (parent) {
      names.unshift(parent.name)
      parent = parent.parentId ? byId.get(parent.parentId) : null
    }
    return names
  }
  const hiddenByAncestor = (entry) => {
    let parent = entry.parentId ? byId.get(entry.parentId) : null
    while (parent) {
      if (parent.psdHidden) return true
      parent = parent.parentId ? byId.get(parent.parentId) : null
    }
    return false
  }
  const visible = (entry) => !entry.psdHidden && !hiddenByAncestor(entry)

  const texts = doc.entries
    .filter((entry) => entry.kind === 'text' && entry.text && entry.bounds)
    .map((entry) => ({ entry, rect: rectOf(entry), ...textInfo(entry), groups: ancestors(entry), visible: visible(entry) }))

  const layers = {}
  const evidence = {}
  const unresolved = []
  const used = new Set()
  const assign = (key, item, reason) => {
    layers[key] = item.entry.fullName
    evidence[key] = { layer: item.entry.fullName, reason }
    used.add(item.entry.id)
  }

  // --- gift titles / names ---------------------------------------------------
  const titles = texts
    .filter((item) => item.visible && GIFT_TITLE.test(item.entry.text.value))
    .sort((a, b) => a.rect.y0 - b.rect.y0)
  const giftSlots = []
  titles.forEach((title, index) => {
    const key = `gift_slot${index + 1}`
    assign(`${key}_title`, title, `文字「${title.entry.text.value.trim()}」符合赠品标题模式`)
    // The name sits below its title, overlapping horizontally; prefer the same parent group.
    const below = texts
      .filter(
        (item) =>
          item.visible &&
          !used.has(item.entry.id) &&
          item.rect.y0 >= title.rect.y1 - 4 &&
          item.rect.x0 < title.rect.x1 + 100 &&
          item.rect.x1 > title.rect.x0 - 100 &&
          !NUMBER.test(item.entry.text.value),
      )
      .sort((a, b) => {
        const sameA = a.entry.parentId === title.entry.parentId ? 0 : 1
        const sameB = b.entry.parentId === title.entry.parentId ? 0 : 1
        return sameA - sameB || a.rect.y0 - b.rect.y0
      })
    const next = titles[index + 1]
    const name = below.find((item) => !next || item.rect.y0 < next.rect.y0)
    if (name) assign(`${key}_name`, name, '赠品标题下方、水平重叠的第一段文字')
    else unresolved.push(`${key}_name：没找到标题下方的文字`)
    giftSlots.push({ index, title, name })
  })
  if (!titles.length) unresolved.push('gift：没有识别到赠品标题（买即赠 / 满N送）')

  // --- price -----------------------------------------------------------------
  const numbers = texts.filter((item) => NUMBER.test(item.entry.text.value))
  const priceShown = numbers.filter((item) => item.visible).sort((a, b) => b.px - a.px)[0]
  const priceHidden = numbers.filter((item) => !item.visible).sort((a, b) => b.px - a.px)[0]
  if (priceShown) assign('price_value', priceShown, `可见的纯数字文字，字号最大（${round(priceShown.px)}px）`)
  else unresolved.push('price_value：没有可见的纯数字文字层')
  if (priceHidden) {
    layers.price_legacy = priceHidden.entry.fullName
    evidence.price_legacy = { layer: priceHidden.entry.fullName, reason: '隐藏的纯数字文字层（旧价格，保持隐藏）' }
    used.add(priceHidden.entry.id)
  }

  // --- copy hierarchy by group name, then geometry ---------------------------
  for (const [key, pattern] of ROLE_GROUPS) {
    const hit = texts.find((item) => item.visible && !used.has(item.entry.id) && item.groups.some((name) => pattern.test(name)))
    if (hit) assign(key, hit, `所在分组「${hit.groups.find((name) => pattern.test(name))}」`)
  }
  const free = () => texts.filter((item) => item.visible && !used.has(item.entry.id))
  if (!layers.headline) {
    const top = free().filter((item) => item.rect.cy < doc.height * 0.3).sort((a, b) => b.px - a.px)[0]
    if (top) assign('headline', top, '画布上部 30% 内字号最大的文字（按位置推断）')
  }
  if (!layers.subhead && layers.headline) {
    const head = texts.find((item) => item.entry.fullName === layers.headline)
    const sub = free()
      .filter((item) => item.rect.y0 >= head.rect.y1 - 4 && item.rect.cy < doc.height * 0.4)
      .sort((a, b) => a.rect.y0 - b.rect.y0)[0]
    if (sub) assign('subhead', sub, '一级文案正下方的第一段文字（按位置推断）')
  }
  if (!layers.detail) {
    const detail = free().filter((item) => item.rect.cy > doc.height * 0.85).sort((a, b) => b.px - a.px)[0]
    if (detail) assign('detail', detail, '画布底部 15% 内字号最大的文字（按位置推断）')
  }
  if (!layers.product_name) {
    const name = free().filter((item) => item.rect.cy > doc.height * 0.76 && item.rect.cy < doc.height * 0.88)[0]
    if (name) assign('product_name', name, '商品图下方、价格条上方的文字（按位置推断）')
  }
  for (const key of ['headline', 'subhead', 'detail', 'product_name']) {
    if (!layers[key]) unresolved.push(`${key}：没有识别到对应文字层`)
  }

  // --- icon ---------------------------------------------------------------------
  const icons = texts.filter((item) => item.visible && !used.has(item.entry.id) && item.groups.some((name) => /icon|角标|标签/i.test(name)))
  const iconZh = icons.find((item) => hasCjk(item.entry.text.value))
  const iconEn = icons.find((item) => !hasCjk(item.entry.text.value))
  if (iconZh) assign('icon_zh', iconZh, '分组名含 icon，文字为中文')
  if (iconEn) assign('icon_en', iconEn, '分组名含 icon，文字为英文')

  // --- product slot -----------------------------------------------------------
  const slotCandidates = doc.entries
    .filter((entry) => entry.kind === 'layer' && entry.hasPixels && entry.bounds && visible(entry))
    .map((entry) => ({ entry, rect: rectOf(entry), groups: ancestors(entry) }))
    .filter((item) => item.groups.some((name) => /产品|商品|product|主体/i.test(name)))
    .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
  const slots = {}
  let slotRect = null
  if (slotCandidates[0]) {
    slots.product = slotCandidates[0].entry.fullName
    slotRect = slotCandidates[0].rect
    evidence.product_slot = { layer: slots.product, reason: '产品分组里最大的可见像素层' }
  } else if (doc.slots && doc.slots.size) {
    unresolved.push('slots.product：分组名无法判断，使用引擎自动识别的商品位前请先确认')
  } else {
    unresolved.push('slots.product：没有找到商品位')
  }

  // --- type (fonts, sizes, colours straight from the PSD) -------------------
  const byKey = (key) => texts.find((item) => item.entry.fullName === layers[key])
  const type = {}
  const head = byKey('headline')
  if (head) {
    const { digit, text } = digitSplit(head.entry)
    const body = text || { family: head.run.family, sizePx: round(head.px), color: hex(head.run.color) }
    type.level1 = {
      fitWidth: round(head.rect.w),
      minPx: round(body.sizePx * 0.67),
      text: body,
      digit: digit || body,
    }
  }
  const sub = byKey('subhead')
  if (sub) type.level2 = { family: sub.run.family, sizePx: round(sub.px), color: hex(sub.run.color) }
  const detail = byKey('detail')
  if (detail) {
    // The note only says "size follows text length": keep the template size for the template's own
    // length and shrink longer copy to the same width (a floor stops it from becoming unreadable).
    type.level3 = {
      family: detail.run.family,
      bins: [{ maxChars: null, sizePx: round(detail.px) }],
      fitWidth: round(detail.rect.w),
      minPx: round(detail.px * 0.45),
    }
  }
  const name = byKey('product_name')
  if (name) {
    const length = Math.max(1, name.entry.text.value.trim().length)
    type.productName = {
      family: name.run.family,
      sizePx: round(name.px, 1),
      centerX: round(name.rect.cx),
      anchorX: round(name.rect.x0),
      widthPerChar: round(name.rect.w / length, 1),
    }
  }
  const price = byKey('price_value')
  if (price) {
    const runs = price.entry.text.runs || []
    const first = runs[0]
    const rest = runs.slice(1).filter((run) => run.size)
    const decimal = rest.length ? rest[rest.length - 1].size / (first.size || 1) : null
    type.price = {
      family: first.family,
      color: hex(first.color),
      sizePx2: round((first.size || 0) * price.scale),
      ...(decimal ? { decimalScale: round(decimal, 2) } : {}),
    }
  }
  const t1 = giftSlots[0]
  if (t1) {
    type.giftTitle = { family: t1.title.run.family, sizePx: round(t1.title.px) }
    if (t1.name) type.giftName = { family: t1.name.run.family, sizePx: round(t1.name.px) }
  }
  if (iconZh) type.iconZh = { family: iconZh.run.family, sizePx: round(iconZh.px) }
  if (iconEn) type.iconEn = { family: iconEn.run.family, sizePx: round(iconEn.px) }

  // --- gift anchors: the picture zone between title and name -------------------
  // Tiers share one card width: use the widest name box so a short caption
  // ("限量1000件") does not narrow the picture zone of its tier.
  const named = giftSlots.filter((slot) => slot.name)
  const cardLeft = named.length ? Math.min(...named.map((slot) => slot.name.rect.x0)) : 0
  const cardRight = named.length ? Math.max(...named.map((slot) => slot.name.rect.x1)) : 0
  const giftSlotRules = named
    .map((slot, index) => ({
      id: index === 0 ? 'upper' : index === 1 ? 'lower' : `slot${index + 1}`,
      titleKey: `gift_slot${slot.index + 1}_title`,
      nameKey: `gift_slot${slot.index + 1}_name`,
      anchor: {
        name: `gift_slot${slot.index + 1}_img`,
        bounds: [
          round(cardLeft + 4),
          round(slot.title.rect.y1 + 7),
          round(cardRight - 1),
          round(slot.name.rect.y0 - 9),
        ],
      },
    }))
  const tiers = giftSlots.slice(0).map((slot) => {
    const title = slot.title.entry.text.value.trim()
    const match = /满\s*(\d+)/.exec(title)
    return match ? { id: `full${match[1]}`, title, name: slot.name ? slot.name.entry.text.value.trim().split('\n')[0] : '' } : null
  }).filter(Boolean)

  const catalog = giftFiles.map((file) => {
    const stem = file.replace(/\.[^.]+$/, '')
    return { name: stem, file }
  })

  const fileList = giftFiles.length ? `；候选图片：${giftFiles.join('、')}` : ''
  for (const tier of tiers) {
    unresolved.push(`gifts.tiers.${tier.id}：PSD 只有文案「${tier.title} / ${tier.name}」，需要指定它对应的图片${fileList}`)
  }
  if (giftFiles.length) {
    unresolved.push('gifts.catalog：只能用文件名作为赠品名；需求表里的赠品名（含 *N、+ 组合）要对应到文件，请补 aliases / files')
  }

  const rules = {
    version: 1,
    template: templateName || doc.fileName || doc.name,
    canvas: { width: doc.width, height: doc.height },
    sheet: {
      name: sheetName || '主图',
      columns: Object.fromEntries(
        Object.entries(DEFAULT_COLUMN_ALIASES).map(([key, aliases]) => [key, Array.isArray(aliases) ? aliases : [aliases]]),
      ),
    },
    layers,
    slots,
    type,
    gifts: {
      buyGiftTitle: titles.find((item) => /买即赠/.test(item.entry.text.value))?.entry.text.value.trim() || '买即赠',
      catalog,
      tiers,
      slots: giftSlotRules,
    },
    containers: price ? { price_value: [round(price.rect.x0 - 60), round(price.rect.y0 - 12), round(price.rect.x1 + 25), round(price.rect.y1 + 26)] } : {},
    validate: {
      ...(price ? { priceRegion: [round(price.rect.x0 - 60), round(price.rect.y0 - 12), round(price.rect.x1 + 25), round(price.rect.y1 + 26)] } : {}),
      ...(price ? { priceRed: { r: price.run.color?.[0] ?? 204, g: price.run.color?.[1] ?? 48, b: price.run.color?.[2] ?? 70, tol: 45 } } : {}),
      ...(slotRect ? { productRegion: [slotRect.x0 - 48, slotRect.y0 - 43, slotRect.x1 + 60, slotRect.y1 + 91].map(round) } : {}),
    },
    export: { formats: ['jpg'], quality: 95, filename: '{sku}-{name}.{ext}' },
  }
  // Icon badge group: shown for NEW/HOT, hidden when the sheet's icon cell is empty. (HOT/包邮 art is
  // not in the PSD, so those still show the template badge until the designer supplies one.)
  const iconGroups = [...new Set([layers.icon_zh, layers.icon_en].filter(Boolean).map((name) => name.split('/').slice(0, -1).join('/')))].filter(Boolean)
  if (iconGroups.length) {
    rules.variants = { icon: { NEW: { show: iconGroups, hide: [] }, HOT: { show: iconGroups, hide: [] }, NONE: { show: [], hide: iconGroups } } }
  }

  const notes = [
    '一级/二级文案的层级规则（利益点为 / 时二级上提）、赠品顺延优先级、三级文案按字数分档，PSD 里没有，需要对照修改说明补充。',
    ...(giftSlots.length ? ['PSD 只画了已展示的赠品档位；如果修改说明里有第三档，需要手动补进 gifts.tiers。'] : []),
  ]
  return { rules, evidence, unresolved, notes }
}
