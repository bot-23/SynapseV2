import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test('桌面导航采用深色主题并保留全部入口', async ({ page }) => {
  await onboard(page)
  await expect(page.locator('.nav-item')).toHaveCount(6)
  expect(
    await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(19, 34, 57)')
  await expect(page.getByRole('button', { name: '新对话' })).toBeVisible()
})

test('「我的」页按「今日状态 → 学习资产 → 设置」分组，Key 表单默认收起', async ({ page }) => {
  await onboard(page)
  await page.locator('.nav-item', { hasText: '我的' }).click()

  await expect(page.locator('.mine-group-title')).toHaveText(['今日状态', '学习资产', '设置'])
  await expect(page.locator('.mine-card .card-title, .mine-card .card-title-inline')).toHaveText([
    '学习仪表盘',
    'AI 学情周报',
    '我的科目',
    '我的课程表',
    '资料库',
    '知识图谱',
    '学习画像',
    'AI 模型接入',
    '数据管理',
  ])

  // API Key 不再明晃晃摆着：默认只有状态说明，点「配置 Key」才出现输入框
  const keyCard = page.locator('.mine-card', { hasText: 'AI 模型接入' })
  await expect(keyCard.locator('input[type="password"]')).toHaveCount(0)
  await expect(keyCard).toContainText('本地规则模式')
  await keyCard.getByRole('button', { name: '配置 Key' }).click()
  await expect(keyCard.locator('input[type="password"]')).toHaveCount(1)
  await keyCard.getByRole('button', { name: '收起' }).click()
  await expect(keyCard.locator('input[type="password"]')).toHaveCount(0)
})

test('主要页面有明确的页面标题，图谱可以返回', async ({ page }) => {
  await onboard(page)
  for (const [nav, heading] of [
    ['计划', '学习计划'],
    ['作业', '作业清单'],
    ['资料库', '学习资料'],
    ['课程表', '课程安排'],
    ['我的', '我的空间'],
  ] as const) {
    await page.getByRole('button', { name: nav, exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: /知识图谱/ }).click()
  await expect(page.getByRole('heading', { name: '个人知识图谱' })).toBeVisible()
  await page.getByRole('button', { name: '返回我的' }).click()
  await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
})

test('侧边栏可以拖宽、重启后记住宽度、双击复位', async ({ page }) => {
  await onboard(page)
  const sidebarWidth = () =>
    page.locator('.sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().width))

  expect(await sidebarWidth()).toBe(252)

  const handle = page.locator('.sidebar-resizer')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.height / 2)
  await page.mouse.down()
  await page.mouse.move(340, box.height / 2, { steps: 8 })
  await page.mouse.up()

  expect(await sidebarWidth()).toBe(340)
  expect(await page.evaluate(() => localStorage.getItem('synapse.sidebarWidth'))).toBe('340')

  // 上限之外的部分被夹住，不会把主区域挤没
  await page.mouse.move(340, box.height / 2)
  await page.mouse.down()
  await page.mouse.move(900, box.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await sidebarWidth()).toBe(420)

  await handle.dblclick()
  expect(await sidebarWidth()).toBe(252)

  await page.reload()
  await expect(page.locator('.app-shell')).toBeVisible()
  expect(await sidebarWidth()).toBe(252)
})

test('手机上各页可导航且没有页面横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await onboard(page)
  for (const [nav, heading] of [
    ['计划', '学习计划'],
    ['作业', '作业清单'],
    ['资料库', '学习资料'],
    ['课程表', '课程安排'],
    ['我的', '我的空间'],
  ] as const) {
    await page.getByRole('button', { name: nav, exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    expect(await page.locator('.app-main').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(375)
  }
})
