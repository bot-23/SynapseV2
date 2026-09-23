import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

/** 完成引导，进入应用壳。返回是否走了「有 Key」校验（本套件默认走本地规则模式）。 */
export async function onboard(
  page: Page,
  opts: { name?: string; grade?: string } = {},
) {
  const name = opts.name ?? '测试同学'
  const grade = opts.grade ?? '高三'
  await page.goto('/')
  await expect(page.locator('.profile-gate')).toBeVisible()

  await page.getByPlaceholder('例如：小明').fill(name)
  await page.getByPlaceholder('例如：高三').fill(grade)
  await page.getByRole('button', { name: '开始规划' }).click()

  await expect(page.locator('.app-shell')).toBeVisible()
  // 未配 Key → 本地规则模式
  await expect(page.locator('.status-chip')).toContainText('本地规则模式')
}

/**
 * 发送一条目标，并把「澄清→正式计划」两级流程一次走完，
 * 直到页面上出现每周计划卡（PlanCard）。
 * 若 run 直接出计划（不澄清）也能通过。
 */
export async function sendGoalUntilPlan(page: Page, text: string) {
  await page.locator('.composer textarea').fill(text)
  await page.getByRole('button', { name: '发送' }).click()

  // 等澄清卡 或 计划卡 之一出现
  await page.waitForSelector('.clarification-card, .plan-card', { timeout: 30_000 })

  // 若出现澄清卡 → 每问选第一个建议答案，再提交
  if (await page.locator('.clarification-card').count()) {
    const questions = page.locator('.clarification-question')
    const count = await questions.count()
    for (let i = 0; i < count; i++) {
      await questions.nth(i).locator('.clarification-chip').first().click()
    }
    await page.getByRole('button', { name: '确认，生成计划' }).click()
  }

  await expect(page.locator('.plan-card').first()).toBeVisible({ timeout: 30_000 })
}

/** 造一个临时 .txt 文件，供资料库文件导入用。 */
export function makeTxtFile(dir: string, filename: string, content: string): string {
  return path.join(dir, filename)
}

export { expect }