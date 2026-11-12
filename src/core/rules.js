/**
 * Template-agnostic business rules: copy hierarchy, gift tiers, type sizes,
 * mixed headline runs, icon variants. All thresholds live in the rules JSON.
 */
import { isUnset } from './mapping.js'

function pathBasename(file) {
  const text = String(file || '').replace(/\\/g, '/')
  const parts = text.split('/')
  return parts[parts.length - 1]
}

export function countChars(text) {
  return Array.from(String(text || '')).length
}

export function resolveCopy(row) {
  const name = String(row.name || row.productName || '').trim()
  const headline = isUnset(row.headline) ? '' : String(row.headline).trim()
  const feature = isUnset(row.feature) ? '' : String(row.feature).trim()
  const detail = isUnset(row.detail) ? '' : String(row.detail).trim()
  if (!headline) {
    return {
      level1: feature || name,
      level2: name,
      level3: detail,
      headlinePromoted: true,
    }
  }
  return {
    level1: headline,
    level2: feature || name,
    level3: detail,
    headlinePromoted: false,
  }
}

export function sizeForLength(text, bins = []) {
  const length = countChars(text)
  for (const bin of bins) {
    if (bin.maxChars == null || length <= Number(bin.maxChars)) return Number(bin.sizePx)
  }
  return bins.length ? Number(bins[bins.length - 1].sizePx) : null
}

export function mixedNumberRuns(text, { text: textStyle = {}, digit: digitStyle = {} } = {}) {
  const value = String(text || '')
  const runs = []
  let index = 0
  while (index < value.length) {
    const digit = /\d/.test(value[index])
    let end = index + 1
    while (end < value.length && /\d/.test(value[end]) === digit) end += 1
    const style = digit ? digitStyle : textStyle
    runs.push({
      len: end - index,
      family: style.family,
      sizePx: style.sizePx,
      color: style.color,
      weight: style.weight,
    })
    index = end
  }
  return runs.filter((run) => run.len > 0)
}

export function formatPrice(value) {
  if (value == null) return ''
  const raw = String(value).trim()
  if (!raw || raw === '/') return ''
  return raw
}

export function priceRuns(text, cfg = {}) {
  const value = formatPrice(text)
  if (!value) return []
  const family = cfg.family
  const color = cfg.color
  const dot = value.indexOf('.')
  const intPart = dot < 0 ? value : value.slice(0, dot)
  const intPx =
    intPart.length <= 2 ? cfg.sizePx2 ?? cfg.sizePx ?? 150 : cfg.sizePx3 ?? cfg.sizePx ?? 135
  const decimalPx =
    cfg.decimalPx ??
    (cfg.decimalScale ? Math.round(intPx * Number(cfg.decimalScale)) : cfg.sizePxDecimal ?? 90)
  if (dot < 0) {
    return [{ len: value.length, family, sizePx: intPx, color }]
  }
  return [
    { len: dot, family, sizePx: intPx, color },
    { len: value.length - dot, family, sizePx: decimalPx, color },
  ]
}

export function resolveIcon(icon) {
  if (isUnset(icon)) return { variant: 'NONE', en: '', zh: '' }
  const text = String(icon)
  if (/HOT|爆品/i.test(text)) return { variant: 'HOT', en: 'HOT', zh: '爆品热卖' }
  if (/包邮/i.test(text)) return { variant: 'SHIP', en: '', zh: '包邮' }
  if (/NEW|新品/i.test(text)) return { variant: 'NEW', en: 'NEW', zh: '新品上市' }
  return { variant: 'CUSTOM', en: '', zh: text.trim(), raw: text }
}

function catalogFiles(name, catalog = []) {
  if (isUnset(name)) return { files: [], missing: false }
  const raw = String(name)
    .split(/[，,\n]/)[0]
    .replace(/（.*?）/g, '')
    .trim()
  const hit = catalog.find((item) => item.name === raw || (item.aliases || []).includes(raw))
  if (!hit) return { files: [], missing: true, query: raw }
  const files = hit.files || (hit.file ? [hit.file] : [])
  return { files, missing: files.length === 0, query: raw, title: hit.title }
}

export function resolveGifts(row, rules = {}) {
  const gifts = rules.gifts || {}
  const catalog = gifts.catalog || []
  const tiers = Object.fromEntries((gifts.tiers || []).map((tier) => [tier.id, tier]))
  const full79 = tiers.full79 || { id: 'full79', title: '满79送', name: '贝果短绒粉扑*2' }
  const full129 = tiers.full129 || { id: 'full129', title: '满129送', name: '啵啵棉粉扑*1' }
  const buy = isUnset(row.buyGift) ? '' : String(row.buyGift).trim()

  const pack = (slot, title, name, extra = {}) => {
    const found = extra.files ? { files: extra.files, missing: extra.files.length === 0 } : catalogFiles(name, catalog)
    return { slot, title, name, files: found.files, missing: found.missing, query: found.query || name }
  }

  if (!buy) {
    return [
      pack('upper', full79.title || '满79送', full79.name, { files: full79.files || catalogFiles(full79.name, catalog).files }),
      pack(
        'lower',
        full129.title || '满129送',
        full129.name,
        { files: full129.files || catalogFiles(full129.name, catalog).files },
      ),
    ]
  }

  const buyFiles = catalogFiles(buy, catalog)
  return [
    pack('upper', gifts.buyGiftTitle || '买即赠', buy, { files: buyFiles.files }),
    pack('lower', full79.title || '满79送', full79.name, { files: full79.files || catalogFiles(full79.name, catalog).files }),
  ]
}

export function productNameDx(name, cfg = {}) {
  if (!cfg || cfg.centerX == null || cfg.anchorX == null) return 0
  const width = countChars(name) * Number(cfg.widthPerChar || 27.5)
  return Math.round(Number(cfg.centerX) - (Number(cfg.anchorX) + width / 2))
}

export function filenameFromTemplate(template, values) {
  const source = template || '{sku}-{name}.{ext}'
  return source.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key]
    return value == null ? '' : String(value)
  })
}

export function sanitizeFilename(name) {
  return (
    String(name || 'sku')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'sku'
  )
}

export function layerRef(rules, key) {
  const layers = rules?.layers || {}
  return layers[key] || key
}

/**
 * Expand one requirement row + mapping row into render inputs.
 * Does not read the PSD; layer names come from the rules file.
 */
export function expandRow(row, mapping = {}, rules = {}) {
  const name = (mapping.name || row.name || '').trim()
  const sku = String(row.sku || mapping.sku || '').trim()
  const copy = resolveCopy({ ...row, name })
  // mapping.csv carries empty strings for columns it does not set; those must
  // not blank out the requirement row (e.g. 买即赠).
  const mappingValues = Object.fromEntries(Object.entries(mapping).filter(([, value]) => !isUnset(value)))
  const gifts = resolveGifts({ ...row, ...mappingValues }, rules)
  // The catalog decides which files a gift uses (a combo like 睫毛夹+遮瑕刷 is
  // two files); mapping gift files only fill gifts the catalog could not resolve.
  if (!isUnset(mapping.gift1File) && gifts[0] && (gifts[0].missing || !gifts[0].files.length)) {
    gifts[0].files = [pathBasename(mapping.gift1File)]
    gifts[0].missing = false
  }
  if (!isUnset(mapping.gift2File) && gifts[1] && (gifts[1].missing || !gifts[1].files.length)) {
    gifts[1].files = [pathBasename(mapping.gift2File)]
    gifts[1].missing = false
  }
  const icon = resolveIcon(row.icon)
  const price = formatPrice(row.price)
  const type = rules.type || {}
  const texts = []
  const visibility = []
  const warnings = []

  const pushText = (key, patch) => {
    const layer = layerRef(rules, key)
    if (!layer || layer === key && !rules.layers?.[key]) {
      warnings.push(`rules.layers 缺少 ${key}`)
    }
    texts.push({ layer, ...patch })
  }

  if (price) {
    pushText('price_value', {
      value: price,
      runs: priceRuns(price, type.price || {}),
      decimalScale: type.price?.decimalScale,
    })
  }

  const headlineCfg = type.level1 || {}
  const headlineRuns = copy.headlinePromoted
    ? mixedNumberRuns(copy.level1, { text: headlineCfg.text || headlineCfg, digit: headlineCfg.text || headlineCfg })
    : mixedNumberRuns(copy.level1, headlineCfg)
  pushText('headline', {
    value: copy.level1,
    runs: headlineRuns,
    ...(headlineCfg.fitWidth ? { fitWidth: headlineCfg.fitWidth, minPx: headlineCfg.minPx, maxPx: headlineCfg.maxPx } : {}),
  })

  const level2 = type.level2 || {}
  pushText('subhead', {
    value: copy.level2,
    font: level2.family,
    sizePx: level2.sizePx,
    color: level2.color,
  })

  const level3 = type.level3 || {}
  const level3Size = sizeForLength(copy.level3, level3.bins || [])
  if (copy.level3) {
    pushText('detail', {
      value: copy.level3,
      font: level3.family,
      sizePx: level3Size,
      ...(level3.fitWidth ? { fitWidth: level3.fitWidth, minPx: level3.minPx, maxPx: level3.maxPx } : {}),
    })
  }

  const product = type.productName || {}
  pushText('product_name', {
    value: name,
    font: product.family,
    sizePx: product.sizePx,
    dx: productNameDx(name, product),
  })

  const slotCfg = (rules.gifts && rules.gifts.slots) || []
  gifts.forEach((gift, index) => {
    const slot = slotCfg[index] || {}
    if (slot.titleLayer || slot.titleKey) {
      texts.push({
        layer: slot.titleLayer || layerRef(rules, slot.titleKey),
        value: gift.title,
        font: type.giftTitle?.family,
        sizePx: gift.title.includes('129') ? type.giftTitle?.sizePxLong : type.giftTitle?.sizePx,
      })
    }
    if (slot.nameLayer || slot.nameKey) {
      const long = countChars(gift.name) >= (type.giftName?.longChars || 16)
      texts.push({
        layer: slot.nameLayer || layerRef(rules, slot.nameKey),
        value: gift.name,
        font: type.giftName?.family,
        sizePx: long ? type.giftName?.sizePxLong : type.giftName?.sizePx,
      })
    }
    if (gift.missing) warnings.push(`赠品未映射: ${gift.query || gift.name}`)
  })

  const iconLayers = rules.variants?.icon || {}
  const variant = iconLayers[icon.variant]
  if (variant) {
    for (const layer of variant.hide || []) visibility.push({ layer, hidden: true })
    for (const layer of variant.show || []) visibility.push({ layer, hidden: false })
  }
  if (icon.zh && (rules.layers?.icon_zh || iconLayers.NEW)) {
    pushText('icon_zh', { value: icon.zh, font: type.iconZh?.family, sizePx: type.iconZh?.sizePx })
  }
  if (icon.en && rules.layers?.icon_en) {
    pushText('icon_en', { value: icon.en, font: type.iconEn?.family, sizePx: type.iconEn?.sizePx })
  }

  const productFile = mapping.productFile || row.productFile
  const ext = (rules.export && rules.export.extension) || 'png'
  const filename = sanitizeFilename(
    filenameFromTemplate(rules.export?.filename, { sku, name, ext }).replace(/\.$/, ''),
  )

  return {
    sku,
    name,
    productFile,
    copy,
    gifts,
    icon,
    price,
    texts,
    visibility,
    warnings,
    filename,
    variant: { icon: icon.variant },
  }
}

export function collectOverrideFonts(texts) {
  const families = new Set()
  for (const item of texts || []) {
    if (item.font) families.add(item.font)
    for (const run of item.runs || []) if (run.family) families.add(run.family)
  }
  return [...families]
}
