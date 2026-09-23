import { test, expect } from '@playwright/test'
import { onboard } from './helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test.describe('资料库', () => {
  test('粘贴导入 → 出现在列表 → 删除', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    await expect(page.locator('.mine-card .card-title').first()).toHaveText('粘贴导入')
    await page.getByPlaceholder('资料名，如 高数错题笔记').fill('高数笔记')
    await page
      .locator('.mine-textarea')
      .fill('泰勒公式：若函数在 x0 附近有 n+1 阶导数，则可展开为多项式加上余项。')

    await page.getByRole('button', { name: '导入资料' }).click()
    // 应出现导入成功的提示 + 列表里有这条资料
    await expect(page.locator('.doc-row').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.doc-name').first()).toHaveText('高数笔记')
    await expect(page.locator('.mine-card', { hasText: '已导入' })).toContainText('已导入（1）')

    // 从资料构建图谱，并在「我的」进入可视化页
    await page.getByRole('button', { name: '构建图谱' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('已新增', { timeout: 15_000 })
    await page.locator('.nav-item', { hasText: '我的' }).click()
    const graphEntry = page.getByRole('button', { name: /知识图谱/ })
    await expect(graphEntry).toContainText('15 个节点')
    await graphEntry.click()
    await expect(page.getByRole('img', { name: '个人知识图谱' })).toBeVisible()
    await expect(page.locator('.graph-node')).toHaveCount(15)
    await page.getByRole('button', { name: '返回我的' }).click()
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    // 删除
    page.once('dialog', (dialog) => dialog.accept())
    await page.locator('.doc-remove').first().click()
    await expect(page.locator('.mine-card', { hasText: '已导入' })).toContainText('已导入（0）')
  })

  test('从本机文件导入 .txt', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-doc-'))
    const filePath = path.join(dir, '物理笔记.txt')
    fs.writeFileSync(filePath, '动量守恒定律：系统所受合外力为零时，总动量保持不变。', 'utf-8')

    // 隐藏的 file input 通过 setInputFiles 触发
    await page.setInputFiles('input.file-input', filePath)
    await expect(page.locator('.doc-name').first()).toHaveText('物理笔记.txt', {
      timeout: 15_000,
    })
  })
})
