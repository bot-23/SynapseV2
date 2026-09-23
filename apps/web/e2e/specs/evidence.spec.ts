import { test, expect } from '@playwright/test'
import { onboard, sendGoalUntilPlan } from './helpers'

test.describe('AI 依据展开', () => {
  test('计划卡能摊开「AI 为什么这么安排」：命中的规则 + 图谱学习路径', async ({ page }) => {
    await onboard(page, { name: '测试', grade: '高一' })
    await sendGoalUntilPlan(page, '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟')

    const card = page.locator('.plan-card').first()
    // 默认收起：证据面板不占地方
    await expect(card.locator('.plan-evidence-body')).toHaveCount(0)

    await card.getByRole('button', { name: 'AI 为什么这么安排' }).click()
    const body = card.locator('.plan-evidence-body')
    await expect(body).toBeVisible()

    // 规则命中项展示的是真实的确定性规则，不是模型的话术
    await expect(body.locator('.plan-evidence-title').first()).toContainText('命中的规则')
    await expect(body).toContainText('每天任务总量控制在')
    // 离线模式没有资料，但内置知识图谱仍会给出学习路径
    await expect(body).toContainText('图谱学习路径')

    await card.getByRole('button', { name: '收起依据' }).click()
    await expect(card.locator('.plan-evidence-body')).toHaveCount(0)
  })
})
