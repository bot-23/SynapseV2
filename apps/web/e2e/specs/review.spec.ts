import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('苏格拉底提示', () => {
  test('复习卡「提示我」逐级揭示，三级用完才允许看答案', async ({ page }) => {
    await onboard(page)

    // 演示数据里带了到期复习卡（无 Key → 提示走离线规则版，且必须明确标出来）
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: '载入演示数据' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
      timeout: 20_000,
    })

    await page.locator('.nav-item', { hasText: '计划' }).click()
    await page.locator('.plan-tab', { hasText: '复习' }).click()

    // 1. 第一次点「提示我」：出现面板，只揭示第一条
    const panel = page.locator('.review-hint-panel')
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: '提示我' }).first().click()
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('离线提示')
    await expect(panel.locator('.review-hint-list li')).toHaveCount(1)

    // 2. 三级提示没用完，答案按钮不可点
    const answerButton = panel.locator('.review-answer-button')
    await expect(answerButton).toBeDisabled()
    await expect(answerButton).toContainText('三级提示用完才可看答案')

    // 3. 逐级揭示到第三条
    await page.getByRole('button', { name: '再提示一点' }).first().click()
    await expect(panel.locator('.review-hint-list li')).toHaveCount(2)
    await expect(answerButton).toBeDisabled()

    await page.getByRole('button', { name: '再提示一点' }).first().click()
    await expect(panel.locator('.review-hint-list li')).toHaveCount(3)
    await expect(page.getByRole('button', { name: '提示给完了' }).first()).toBeDisabled()

    // 4. 三级用完 → 答案解锁，且答案要说明依据来自哪里
    await expect(answerButton).toBeEnabled()
    await expect(answerButton).toHaveText('查看答案')
    await answerButton.click()
    await expect(panel.locator('.review-answer')).toBeVisible()
    await expect(panel.locator('.review-answer-source')).toContainText('依据：')
  })
})
