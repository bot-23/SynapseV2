import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('今日最小启动行动', () => {
  test('「先学 5 分钟」一键记下启动，走的是同一条打卡链路', async ({ page }) => {
    await onboard(page)

    await page.locator('.nav-item', { hasText: '计划' }).click()
    // 手动加一条今天的任务，不必先生成一整版计划
    await page.locator('.plan-add-input').fill('复习夹逼定理')
    await page.getByRole('button', { name: '加入' }).click()
    await expect(page.locator('.plan-task-row')).toHaveCount(1)

    const starter = page.locator('.plan-starter')
    await expect(starter).toBeVisible()
    await expect(starter).toContainText('先学 5 分钟')
    await expect(starter).toContainText('复习夹逼定理')

    // 点一下就打卡：进度变 1/1，启动条交给下一条（今天已做完就消失）
    await starter.click()
    await expect(page.locator('.plan-summary .progress-text')).toHaveText('1/1')
    await expect(starter).toHaveCount(0)
  })
})
