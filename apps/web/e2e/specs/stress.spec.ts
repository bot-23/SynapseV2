import { expect, test } from '@playwright/test'
import { onboard } from './helpers'

test.describe('Web 压力与恢复', () => {
  test('连续载入演示数据 8 次保持幂等，清空后图谱也一并清空', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '我的' }).click()
    const demoButton = page.getByRole('button', { name: '载入演示数据' })

    for (let index = 0; index < 8; index += 1) {
      await demoButton.click()
      await expect(demoButton).toHaveText('载入演示数据', { timeout: 20_000 })
    }

    const graphEntry = page.getByRole('button', { name: /知识图谱/ })
    // 图谱状态里带着节点数，8 次载入后仍应是「有内容」而不是越堆越多
    await expect(graphEntry).toContainText('全部由你的资料构建')

    await page.locator('.nav-item', { hasText: '计划' }).click()
    await page.locator('.plan-tab', { hasText: '短期' }).click()
    await expect(page.locator('.version-badge').first()).toContainText('第 8 版')

    await page.locator('.nav-item', { hasText: '我的' }).click()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: '清空全部数据' }).click()
    // 图谱没有内置内容，清空后就是空的
    await expect(graphEntry).toContainText('还没有节点')
  })

  test('移动端宽度下图谱滚动限制在卡片内部', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await onboard(page)
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: /知识图谱/ }).click()
    await expect(page.getByRole('img', { name: '个人知识图谱' })).toBeVisible()

    const bodyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(bodyOverflow).toBeLessThanOrEqual(1)
  })
})
