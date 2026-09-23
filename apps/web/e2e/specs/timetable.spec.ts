import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test.describe('课程表', () => {
  test('粘贴解析 → 保存 → 我的页显示数量', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '课程表' }).click()

    await page
      .locator('.mine-textarea')
      .fill('周一 高等数学 08:00-09:40\n周一 大学物理 10:00-11:40\n周三 线性代数 14:00-15:40')
    await page.getByRole('button', { name: '解析这段文本' }).click()

    await expect(page.locator('.tt-entry').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.tt-list-header .card-title')).toHaveText('课表（3 节）')
    await expect(page.locator('.tt-dirty')).toBeVisible()

    // 保存
    await page.getByRole('button', { name: '保存课表' }).click()
    await expect(page.getByRole('button', { name: '课表已是最新' })).toBeVisible({ timeout: 15_000 })

    // 我的页应显示课程数量
    await page.locator('.nav-item', { hasText: '我的' }).click()
    await expect(page.locator('.mine-card', { hasText: '我的课程表' })).toContainText('已录入 3 节课')
  })

  test('手动添加一节并保存', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '课程表' }).click()

    // 手动添加
    await page.locator('.mine-card', { hasText: '手动添加一节' }).getByPlaceholder('课程名，如 高等数学').fill('英语听力')
    await page.getByRole('button', { name: '添加到课表' }).click()
    await expect(page.locator('.tt-entry-name').first()).toHaveText('英语听力')
    await page.getByRole('button', { name: '保存课表' }).click()
    await expect(page.getByRole('button', { name: '课表已是最新' })).toBeVisible()
  })

  test('粘贴「第 N-M 节」写法可直接解析（无需手抄钟点）', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '课程表' }).click()

    await page
      .locator('.mine-textarea')
      .fill('周一 高等数学 第1-2节\n周三 线性代数 第3-4节 1-16周')
    await page.getByRole('button', { name: '解析这段文本' }).click()

    await expect(page.locator('.tt-entry').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.tt-list-header .card-title')).toHaveText('课表（2 节）')
    // 节次按默认作息表换算成钟点：第 1-2 节 = 08:00 - 09:40
    await expect(page.locator('.tt-entry').first()).toContainText('08:00 - 09:40')
  })
})