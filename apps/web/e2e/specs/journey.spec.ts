import { test, expect } from '@playwright/test'
import { onboard, sendGoalUntilPlan } from './helpers'

test.describe('完整用户旅程', () => {
  test('引导 → 生成计划 → 计划页更新 → 积木模式 → 我的', async ({ page }) => {
    // 1. 引导
    await onboard(page, { name: '小李', grade: '高三' })
    await expect(page.locator('.account-panel strong')).toHaveText('小李')

    // 2. 发送目标话术，走完「澄清→正式计划」两级流程
    const goal = '帮我准备高等数学和大学物理期末考试，每天能学 90 分钟'
    await sendGoalUntilPlan(page, goal)

    // 3. 计划卡（一周安排）被渲染出来
    await expect(page.locator('.plan-card-title').first()).toHaveText('学习计划')
    const subjectGroups = page.locator('.plan-subject-group')
    await expect(subjectGroups.first()).toBeVisible()

    // 4. 切到「计划」页
    await page.locator('.nav-item', { hasText: '计划' }).click()
    // 短期 tab
    await page.locator('.plan-tab', { hasText: '短期' }).click()
    // 有当前计划版本
    await expect(page.locator('.version-badge').first()).toContainText('第 1 版')
    await expect(page.locator('.plan-day-card').first()).toBeVisible()
    // 科目筛选 chips 出现
    await expect(page.locator('.subject-chip').first()).toBeVisible()

    // 5. 打卡一条任务：点第一行的勾选框，进度从 0/n 变 1/n
    const progressText = page.locator('.plan-summary .progress-text').first()
    await expect(progressText).toHaveText(/0\/\d+/)
    await page.locator('.plan-task-row').first().click()
    await expect(progressText).toHaveText(/1\/\d+/)

    // 6. 复习 tab：手动加一个知识点，应出现在「今天该复习」
    await page.locator('.plan-tab', { hasText: '复习' }).click()
    await expect(page.locator('.review-section-title').first()).toHaveText('今天该复习')
    await page.getByPlaceholder('科目，如 高等数学').fill('高等数学')
    await page.getByPlaceholder('知识点，如 夹逼定理').fill('夹逼定理')
    await page.getByRole('button', { name: '加入' }).click()
    // 新加知识点进队列，按间隔重复安排在近期（未必今天到期）
    await expect(
      page.locator('.review-section').locator('.review-topic').filter({ hasText: '夹逼定理' }),
    ).toHaveCount(1)

    // 7. 长期 tab：跨越一周的目标会自动划阶段；否则手动划一次以验证链路
    await page.locator('.plan-tab', { hasText: '长期' }).click()
    if ((await page.locator('.milestone-card').count()) === 0) {
      await page.getByPlaceholder('总目标，例如：三个月过六级').fill('三个月过六级')
      await page.getByPlaceholder('截止日期，格式 2026-12-21').fill('2026-12-21')
      await page.getByRole('button', { name: '划分阶段' }).click()
    }
    await expect(page.locator('.milestone-card').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.milestone-status').first()).toContainText('进行中')

    // 8. 「我的」页
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await expect(page.locator('.mine-header-name')).toHaveText('小李')
    // 知识图谱有内置节点
    await expect(page.locator('.mine-card', { hasText: '知识图谱' })).toContainText('9 个节点')
    // 澄清路径也应把目标里提到的科目记进「我的科目」
    const subjectCard = page.locator('.mine-card', { hasText: '我的科目' })
    await expect(subjectCard.locator('.subject-name').first()).toBeVisible({ timeout: 10_000 })
    // 数据管理入口存在
    await expect(page.getByRole('button', { name: '清空全部数据' })).toBeVisible()

    // 9. 历史会话：切回对话应看到会话卡
    await page.locator('.nav-item', { hasText: '对话' }).click()
    await expect(page.locator('.history-item').first()).toBeVisible()
    await expect(page.locator('.history-item .history-select span').first()).toContainText(goal)
  })

  test('一键载入演示数据后可直接查看计划、复习和资料图谱', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: '载入演示数据' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
      timeout: 20_000,
    })

    const graphEntry = page.getByRole('button', { name: /知识图谱/ })
    await expect(graphEntry).toContainText('来自资料')
    await graphEntry.click()
    await expect(page.locator('.graph-node')).not.toHaveCount(9)

    await page.locator('.nav-item', { hasText: '计划' }).click()
    await page.locator('.plan-tab', { hasText: '短期' }).click()
    await expect(page.locator('.version-badge').first()).toContainText('第 1 版')
    await page.locator('.plan-tab', { hasText: '复习' }).click()
    await expect(page.locator('.review-topic').first()).toBeVisible()
  })

  test('图谱页按掌握度着色：演示数据一进来就有红黄绿，且能看到判定理由', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await page.getByRole('button', { name: '载入演示数据' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
      timeout: 20_000,
    })

    await page.getByRole('button', { name: /知识图谱/ }).click()

    // 四色图例齐全，且掌握 / 在学 / 薄弱都真的有节点（否则就是一片灰，热力图白做）
    await expect(page.locator('.graph-legend-item')).toHaveCount(4)
    const legend = page.locator('.graph-legend')
    await expect(legend).toContainText(/已掌握 [1-9]/)
    await expect(legend).toContainText(/在学 [1-9]/)
    await expect(legend).toContainText(/薄弱 [1-9]/)

    // 节点真的按掌握度上了色：至少两种不同填充色
    const fills = await page
      .locator('.graph-node circle')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('fill') ?? ''))
    expect(new Set(fills).size).toBeGreaterThanOrEqual(2)

    // 点中一个薄弱节点，详情里要能说清「为什么是红的」
    const weakNode = page.locator('.graph-node circle[fill="#dc2626"]').first()
    await expect(weakNode).toBeVisible()
    await weakNode.click()
    await expect(page.locator('.graph-detail')).toContainText('薄弱')
    await expect(page.locator('.graph-detail')).toContainText('张复习卡判定')
  })
})
