import assert from 'node:assert/strict'
import {
  resolveCopy,
  resolveGifts,
  sizeForLength,
  priceRuns,
  mixedNumberRuns,
  expandRow,
} from '../src/core/rules.js'

const bins = [
  { maxChars: 8, sizePx: 57 },
  { maxChars: 11, sizePx: 50 },
  { maxChars: null, sizePx: 44 },
]

assert.equal(sizeForLength('一二三四五六七八', bins), 57)
assert.equal(sizeForLength('一二三四五六七八九', bins), 50)
assert.equal(sizeForLength('一二三四五六七八九十一', bins), 50)
assert.equal(sizeForLength('一二三四五六七八九十一二', bins), 44)

assert.deepEqual(resolveCopy({ headline: '买1享到手2件礼', feature: '10倍定向控油', name: '蜜粉饼8g', detail: '0粉感' }), {
  level1: '买1享到手2件礼',
  level2: '10倍定向控油',
  level3: '0粉感',
  headlinePromoted: false,
})

assert.deepEqual(resolveCopy({ headline: '/', feature: '小巧轻薄 柔焦定妆', name: '植绒粉饼粉扑圆形2只', detail: '' }), {
  level1: '小巧轻薄 柔焦定妆',
  level2: '植绒粉饼粉扑圆形2只',
  level3: '',
  headlinePromoted: true,
})

assert.deepEqual(resolveCopy({ headline: '', feature: '', name: '清透柔光蜜粉饼4g', detail: '24H' }), {
  level1: '清透柔光蜜粉饼4g',
  level2: '清透柔光蜜粉饼4g',
  level3: '24H',
  headlinePromoted: true,
})

assert.deepEqual(resolveCopy({ headline: '买1享到手2件礼', feature: '/', name: '蜜粉饼4g', detail: '' }), {
  level1: '买1享到手2件礼',
  level2: '蜜粉饼4g',
  level3: '',
  headlinePromoted: false,
})

const catalog = [
  { name: '贝果短绒绒*1', aliases: ['贝果短绒粉扑*1'], file: '贝果粉扑.png' },
  { name: '贝果短绒粉扑*2', file: '贝果粉扑.png' },
  { name: '啵啵棉粉扑*1', aliases: ['亲水啵啵棉粉扑*1'], file: '亲水啵啵棉粉扑.png' },
]
const giftRules = {
  gifts: {
    catalog,
    buyGiftTitle: '买即赠',
    tiers: [
      { id: 'full79', title: '满79送', name: '贝果短绒粉扑*2', files: ['贝果粉扑.png'] },
      { id: 'full129', title: '满129送', name: '啵啵棉粉扑*1', files: ['亲水啵啵棉粉扑.png'] },
    ],
  },
}

const withBuy = resolveGifts({ buyGift: '贝果短绒绒*1' }, giftRules)
assert.equal(withBuy[0].title, '买即赠')
assert.equal(withBuy[0].name, '贝果短绒绒*1')
assert.deepEqual(withBuy[0].files, ['贝果粉扑.png'])
assert.equal(withBuy[1].title, '满79送')

const slash = resolveGifts({ buyGift: '/' }, giftRules)
assert.equal(slash[0].title, '满79送')
assert.equal(slash[1].title, '满129送')
assert.deepEqual(slash[1].files, ['亲水啵啵棉粉扑.png'])

const empty = resolveGifts({ buyGift: '' }, giftRules)
assert.equal(empty[0].title, '满79送')
assert.equal(empty[1].title, '满129送')

const price = priceRuns('16.8', { family: 'MiSans-Medium', color: '#CC3046', sizePx2: 150, decimalScale: 0.6 })
assert.equal(price[0].len, 2)
assert.equal(price[0].sizePx, 150)
assert.equal(price[1].len, 2)
assert.equal(price[1].sizePx, 90)

const intPrice = priceRuns('79', { sizePx2: 150, sizePx3: 135 })
assert.equal(intPrice.length, 1)
assert.equal(intPrice[0].sizePx, 150)

const longPrice = priceRuns('125', { sizePx2: 150, sizePx3: 135 })
assert.equal(longPrice[0].sizePx, 135)

const mixed = mixedNumberRuns('买1享到手2件礼', {
  text: { family: 'GlowSansSC-Normal-Bold', sizePx: 100, color: '#000000' },
  digit: { family: 'MinionConceptRoman-Medium', sizePx: 138, color: '#CC3046' },
})
assert.deepEqual(
  mixed.map((run) => run.len),
  [1, 1, 3, 1, 2],
)
assert.equal(mixed[1].color, '#CC3046')
assert.equal(mixed[0].color, '#000000')

const promoted = expandRow(
  { sku: '1', headline: '/', feature: '软弹超贴脸', name: '粉扑2枚', price: '24.9', icon: 'NEW新品上市' },
  { name: '粉扑2枚', productFile: 'a.png' },
  {
    layers: { price_value: '价格数字', headline: '一级', subhead: '二级', detail: '三级', product_name: '产品名', icon_zh: '新品上市', icon_en: 'new' },
    type: {
      level1: {
        text: { family: 'Glow', sizePx: 100, color: '#000000' },
        digit: { family: 'Minion', sizePx: 138, color: '#CC3046' },
      },
    },
  },
)
assert.equal(promoted.copy.headlinePromoted, true)
assert.ok(promoted.texts.find((item) => item.layer === '一级').runs.every((run) => run.color === '#000000'))

console.log('rules test passed')
