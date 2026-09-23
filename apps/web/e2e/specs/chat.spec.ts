import { test, expect } from '@playwright/test'
import { onboard, sendGoalUntilPlan } from './helpers'

test.describe('对话——混合模式', () => {
  test('自由模式：发送自定义目标 → 出现 AI 周计划卡', async ({ page }) => {
    await onboard(page, { name: '测试', grade: '高一' })
    const goal = '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟'
    await sendGoalUntilPlan(page, goal)

    // 用户气泡 + AI 生成标识 + 计划卡
    await expect(page.locator('.message-row.user .message-bubble').first()).toContainText(goal)
    await expect(page.locator('.ai-badge').last()).toHaveText('AI 生成')
    await expect(page.locator('.plan-card').first()).toBeVisible()
  })

  test('积木模式：澄清 → 出积木块 → 展开成一周安排', async ({ page }) => {
    await onboard(page)

    // 切到积木模式
    await page.locator('.planning-mode-switch button', { hasText: '积木' }).click()

    // 发送目标
    await page
      .locator('.composer textarea')
      .fill('一个月后考英语四级，词汇和阅读是重点，每天能学 60 分钟')
    await page.getByRole('button', { name: '发送' }).click()

    // 积木模式第一步必然是澄清（约 4 问）
    await expect(page.locator('.clarification-card').first()).toBeVisible({ timeout: 30_000 })
    const questionCount = await page.locator('.clarification-question').count()
    expect(questionCount).toBeGreaterThan(0)

    // 每问选第一个建议答案，提交
    for (let i = 0; i < questionCount; i++) {
      await page.locator('.clarification-question').nth(i).locator('.clarification-chip').first().click()
    }
    await page.getByRole('button', { name: '确认，生成计划' }).click()

    // 出积木计划卡
    await expect(page.locator('.block-plan-card').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.block-item').first()).toBeVisible()

    // 展开积木 → 一周安排
    await page.locator('.block-expand-button').click()
    await expect(page.locator('.plan-card').first()).toBeVisible({ timeout: 30_000 })
  })
})