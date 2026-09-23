import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('引导页', () => {
  test('空表单点「开始规划」应提示错误', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.profile-gate')).toBeVisible()
    await page.getByRole('button', { name: '开始规划' }).click()
    await expect(page.locator('.form-error')).toHaveText('请先填写称呼和年级')
  })

  test('填写姓名年级进入应用，姓名锁定于「我的」', async ({ page }) => {
    await onboard(page, { name: '阿明', grade: '大二' })
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await expect(page.locator('.mine-header-name')).toHaveText('阿明')
    await expect(page.locator('.mine-header-meta')).toContainText('大二')
    // 姓名已设定 → 显示静态值，不显示输入框
    await expect(page.locator('.mine-card', { hasText: '学习画像' }).getByText('阿明')).toBeVisible()
  })

  test('跳过引导也能进入本地规则模式', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '跳过，先用本地规则模式' }).click()
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.status-chip')).toContainText('本地规则模式')
  })
})