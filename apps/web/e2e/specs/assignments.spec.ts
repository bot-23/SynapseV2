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

  test('作业包：生成二维码与短码，重复导入不长出重复条目', async ({ page }) => {
    await onboard(page)

    await page.locator('.nav-item', { hasText: '作业' }).click()
    await page.locator('.docs-page textarea').first().fill('数学第三章习题1-20明天交')
    await page.getByRole('button', { name: '排进日程' }).click()
    await expect(page.locator('.assignment-row')).toHaveCount(1)

    // 1. 生成作业包：二维码画出来了（画不出会退化成提示块，这里要的是真的二维码）
    await page.getByRole('button', { name: '生成作业包' }).click()
    await expect(page.locator('img.pack-qr')).toBeVisible()
    await expect(page.locator('.pack-side')).toContainText('共 1 条未完成作业')

    // 2. 短码带签名，且人眼可读
    const code = await page.locator('.pack-side textarea').inputValue()
    expect(code.startsWith('SYNAPSE-ASG/1')).toBe(true)
    expect(code).toContain('第三章习题')

    // 3. 把短码粘回去导入：已存在，条目不重复
    await page.locator('.pack-code').last().fill(code)
    await page.getByRole('button', { name: '导入作业包' }).click()
    await expect(page.locator('.notice.snackbar')).toContainText('你已经有了')
    await expect(page.locator('.assignment-row')).toHaveCount(1)
  })

  test('不是作业包的码会被明确拒绝', async ({ page }) => {
    await onboard(page)

    await page.locator('.nav-item', { hasText: '作业' }).click()
    const packInput = page.locator('.pack-code').last()
    await packInput.fill('随便一段文字')
    await page.getByRole('button', { name: '导入作业包' }).click()

    await expect(page.locator('.notice.snackbar')).toContainText('不是作业包')
  })
})
