import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('作业式计划', () => {
  test('对话提交作业 → 清单出现 → 打卡翻转状态', async ({ page }) => {
    await onboard(page)

    // 1. 对话里把老师布置的作业原话丢进来（离线规则解析，不需要 Key）
    await page.locator('.composer textarea').fill('数学第三章习题1-20明天交')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assignment-hint')).toContainText('作业已排进日程', {
      timeout: 30_000,
    })

    // 2. 作业页应出现清单与未来排期
    await page.locator('.nav-item', { hasText: '作业' }).click()
    const firstRow = page.locator('.assignment-row').first()
    await expect(firstRow).toContainText('第三章习题')
    await expect(page.locator('.assignment-day').first()).toBeVisible()

    // 3. 打卡 → 状态翻转（行样式切成 done）
    await page.locator('.assignment-toggle').first().check()
    await expect(page.locator('.assignment-row.done').first()).toBeVisible()
  })

  test('作业页直接排期，倒计时按截止日显示', async ({ page }) => {
    await onboard(page)

    await page.locator('.nav-item', { hasText: '作业' }).click()
    await page.locator('.docs-page textarea').first().fill('英语背Unit3单词周五默写')
    await page.getByRole('button', { name: '排进日程' }).click()

    await expect(page.locator('.assignment-row')).toHaveCount(1)
    await expect(page.locator('.assignment-row').first()).toContainText('背Unit3单词')
    await expect(page.locator('.assignment-countdown').first()).toContainText(/D-\d|今天截止|已逾期/)
  })
})
