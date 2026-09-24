import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('AI 学情周报', () => {
  test('载入演示数据后周报已经算好：数字、能力值变化与离线叙述都来自真实统计', async ({ page }) => {
    await onboard(page)

    // 演示数据带三科打卡与能力值快照，载入后周报就已经是一份有内容的报告
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: '载入演示数据' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
      timeout: 20_000,
    })

    const card = page.locator('.mine-card', { hasText: 'AI 学情周报' })
    await expect(card).toBeVisible()
    await expect(card).not.toContainText('还没生成过周报')

    // 没配 Key → 走离线模板，但每个数字都来自本机统计
    await expect(card.locator('.report-flag')).toContainText('离线模板')
    await expect(card.locator('.report-stat').first()).toContainText('5/5')
    await expect(card).toContainText('完成率')
    await expect(card.locator('.report-narrative')).toContainText('完成率 100%')
    // 三科里至少有一科能力值在涨
    await expect(card.locator('.report-ability').first()).toContainText('+')
    await expect(card.locator('.report-window')).toContainText('统计窗口')

    // 再点一次生成的是新一期，卡片仍在（本机最多保留 8 期）
    await card.getByRole('button', { name: '重新生成本周周报' }).click()
    await expect(card.locator('.report-narrative')).toContainText('完成率 100%')
  })
})
