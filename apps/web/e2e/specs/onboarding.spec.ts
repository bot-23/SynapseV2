import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('引导页', () => {
  test('品牌与欢迎信息层次清楚，手机上也能完整填写', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/')

    await expect(page.locator('.profile-brand')).toContainText('Synapse')
    await expect(page.locator('.profile-gate')).toContainText('把目标，变成每天走得出的路。')
    await expect(page.getByRole('heading', { name: '先认识一下你' })).toBeVisible()
    await expect(page.locator('.profile-gate').getByText('Synapse', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '开始规划' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  })

  test('左侧是只铺在下方的深色星空，主题色取自星空', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')

    const intro = page.locator('.profile-intro')
    await expect(intro).toBeVisible()
    // 夜空底色：面板背景是深色渐变，最深处取自星空 #070d18
    expect(await intro.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
      'rgb(7, 13, 24)',
    )

    const stars = page.locator('.profile-stars')
    await expect(stars).toHaveAttribute('aria-hidden', 'true')
    expect(await stars.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')

    // 只占下面比较空的地方：上方留空、贴着面板底边、不铺满整块
    const panel = await intro.boundingBox()
    const field = await stars.boundingBox()
    if (!panel || !field) {
      throw new Error('左侧面板或星空层没有渲染出来')
    }
    expect(field.y - panel.y).toBeGreaterThanOrEqual(panel.height * 0.3)
    expect(Math.abs(field.y + field.height - (panel.y + panel.height))).toBeLessThanOrEqual(2)
    expect(field.height).toBeLessThanOrEqual(panel.height * 0.8)

    const starStyle = await stars.evaluate((el) => {
      const computed = getComputedStyle(el)
      return {
        backgroundImage: computed.backgroundImage,
        maskImage: computed.maskImage || computed.webkitMaskImage,
      }
    })

    // 多层星点，每层用径向渐变画，越往外越淡（带一点渐变）
    const layers = starStyle.backgroundImage.match(/radial-gradient/g) ?? []
    expect(layers.length).toBeGreaterThanOrEqual(3)
    const fadingStops = starStyle.backgroundImage.match(/rgba\([^)]*,\s*0\)/g) ?? []
    expect(fadingStops.length).toBeGreaterThanOrEqual(layers.length)
    expect(starStyle.maskImage).toContain('linear-gradient')

    // 星星要小
    const sizes = [...starStyle.backgroundImage.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]))
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3)

    // 星星不太亮
    const alphas = [...starStyle.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)]
      .map((m) => m[1].split(',').map((part) => Number(part.trim())))
      .filter((parts) => parts.length === 4)
      .map((parts) => parts[3])
    expect(alphas.length).toBeGreaterThan(0)
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.62)

    // 主题色就取星空里的深空蓝（不用星点青色）
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
      ),
    ).toBe('#132239')
  })

  test('空表单点「开始规划」应提示错误', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.profile-gate')).toBeVisible()
    await page.getByRole('button', { name: '开始规划' }).click()
    await expect(page.locator('.form-error')).toHaveText('请先填写称呼和年级')
  })

  test('填写姓名年级进入应用，姓名锁定于「我的」', async ({ page }) => {
    await onboard(page, { name: '阿明', grade: '大二' })
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await expect(page.locator('.mine-header-name')).toHaveText('阿明')
    await expect(page.locator('.mine-header-meta')).toContainText('大二')
    // 姓名已设定 → 显示静态值，不显示输入框
    await expect(page.locator('.mine-card', { hasText: '学习画像' }).getByText('阿明')).toBeVisible()
  })

  test('跳过引导也能进入本地规则模式', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '跳过，先用本地规则模式' }).click()
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.status-chip')).toContainText('本地规则模式')
  })
})
