import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

  test('流式等待：先显示 stage 进度，再逐字吐出回复', async ({ page }) => {
    await onboard(page)

    await page
      .locator('.composer textarea')
      .fill('我想提升英语四级词汇和阅读，前提是每天只有 45 分钟')
    await page.getByRole('button', { name: '发送' }).click()

    // 打字机光标只存在于流式草稿气泡里；它出现就说明「stage → 逐字渲染」这条链路走通了。
    // 草稿会持续约 1.9 秒，比 stage 气泡（很快被结果替换）更容易稳定断言。
    await expect(page.locator('.typing-caret')).toBeVisible({ timeout: 30_000 })

    // 打字结束后草稿退场，落库的正式消息接上
    await expect(page.locator('.typing-caret')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.ai-badge').first()).toHaveText('AI 生成')
  })

  test('聊天附件：带上资料一起发送，气泡保留附件名', async ({ page }) => {
    await onboard(page)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-chat-att-'))
    const filePath = path.join(dir, '高数笔记.txt')
    fs.writeFileSync(filePath, '导数：含参函数单调性讨论要先求导，再按参数分类讨论。', 'utf-8')

    // 隐藏的 file input 通过 setInputFiles 触发；附件由 core.extractFiles 抽好文本
    await page.setInputFiles('input.chat-attach-input', filePath)
    await expect(page.locator('.composer-attachments .attachment-chip')).toContainText('高数笔记.txt')

    await page.locator('.composer textarea').fill('按这份笔记帮我安排一周复习')
    await page.getByRole('button', { name: '发送' }).click()

    // 发送后：输入框上的待发 chip 清空，消息气泡里保留附件名
    await expect(page.locator('.composer-attachments')).toHaveCount(0)
    await expect(page.locator('.message-attachments .attachment-chip').first()).toContainText(
      '高数笔记.txt',
    )
    await expect(page.locator('.ai-badge').last()).toHaveText('AI 生成', { timeout: 30_000 })
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