import { test, expect } from '@playwright/test'
import { onboard } from './helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 造一个最小但字节合法的单页 PDF（ASCII 文本 + Helvetica），用于验证壳注入的 pdf.js 抽取链路。
 * 内容全是 ASCII，字符数即字节数，所以手工算的 xref 偏移是准确的。
 */
function makePdf(lines: string[]): Buffer {
  const content =
    `BT /F1 12 Tf 40 760 Td 16 TL\n` +
    lines.map((line) => `(${line}) Tj T*`).join('\n') +
    `\nET`
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

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

  test('从本机文件导入 Markdown', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-md-'))
    const filePath = path.join(dir, '高数笔记.md')
    fs.writeFileSync(
      filePath,
      ['# 函数与导数', '', '## 单调性', '', '含参函数先求导，再按参数分类讨论。'].join('\n'),
      'utf-8',
    )

    await page.setInputFiles('input.file-input', filePath)
    await expect(page.locator('.doc-name').first()).toHaveText('高数笔记.md', { timeout: 15_000 })
    await expect(page.locator('.mine-card', { hasText: '已导入' })).toContainText('已导入（1）')
  })

  test('批量上传 3 个 txt：2 个成功、1 个超限并明确提示', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-batch-'))
    const first = path.join(dir, '数学笔记.txt')
    const second = path.join(dir, '英语词汇.txt')
    const tooBig = path.join(dir, '超大文件.txt')
    fs.writeFileSync(first, '导数：含参函数单调性讨论要先求导，再按参数分类。', 'utf-8')
    fs.writeFileSync(second, '词汇：abandon 放弃；ability 能力。', 'utf-8')
    fs.writeFileSync(tooBig, 'x'.repeat(2 * 1024 * 1024 + 16), 'utf-8')

    await page.setInputFiles('input.file-input', [first, second, tooBig])

    // 单个失败不阻塞其他文件：2 成功 + 1 超限，且超限文案明确
    const snackbar = page.locator('.notice.snackbar')
    await expect(snackbar).toContainText('成功 2 个', { timeout: 15_000 })
    await expect(snackbar).toContainText('失败 1 个')
    await expect(snackbar).toContainText('超过 2MB')
    await expect(page.locator('.mine-card', { hasText: '已导入' })).toContainText('已导入（2）')
  })

  test('从本机文件导入 PDF：pdf.js 抽取正文并入库', async ({ page }) => {
    await onboard(page)
    await page.locator('.nav-item', { hasText: '资料库' }).click()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-pdf-'))
    const filePath = path.join(dir, '导数讲义.pdf')
    fs.writeFileSync(
      filePath,
      makePdf([
        'Derivative lecture notes',
        'Monotonicity of parametric functions requires differentiating first.',
      ]),
    )

    await page.setInputFiles('input.file-input', filePath)

    await expect(page.locator('.doc-name').first()).toHaveText('导数讲义.pdf', { timeout: 30_000 })
    // 关键：正文真的被 pdf.js 抽出来了（而不是只把文件名列进列表）
    await expect(page.locator('.doc-excerpt').first()).toContainText('Monotonicity', {
      timeout: 30_000,
    })
    await expect(page.locator('.mine-card', { hasText: '已导入' })).toContainText('已导入（1）')
  })
})
