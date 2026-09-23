import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('AI 学情周报', () => {
  test('载入演示数据后生成周报：卡片出现，数字与离线叙述都来自真实统计', async ({ page }) => {
    await onboard(page)

    // 演示数据里有两天打卡（也顺带生成了能力值快照），周报才有可讲的数字
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: '载入演示数据' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
      timeout: 20_000,
    })

    const card = page.locator('.mine-card', { hasText: 'AI 学情周报' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('还没生成过周报')

    await card.getByRole('button', { name: '生成本周周报' }).click()

    // 没配 Key → 走离线模板，但每个数字都来自本机统计
    await expect(card.locator('.report-flag')).toContainText('离线模板')
    await expect(card.locator('.report-stat').first()).toContainText('2/2')
    await expect(card).toContainText('完成率')
    await expect(card.locator('.report-narrative')).toContainText('完成率 100%')
    await expect(card.locator('.report-ability').first()).toContainText('+0.4')
    await expect(card.locator('.report-window')).toContainText('统计窗口')

    // 再点一次生成的是新一期，卡片仍在（本机最多保留 8 期）
    await card.getByRole('button', { name: '重新生成本周周报' }).click()
    await expect(card.locator('.report-narrative')).toContainText('完成率 100%')
  })
})
