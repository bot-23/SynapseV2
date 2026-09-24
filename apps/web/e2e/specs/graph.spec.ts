import { test, expect, type Page } from '@playwright/test'
import { onboard } from './helpers'

/** 载入演示数据后进入图谱页：三份资料各成一颗星，共 18 个节点。 */
async function openGraphWithDemoData(page: Page) {
  await onboard(page)
  await page.locator('.nav-item', { hasText: '我的' }).click()
  await page.getByRole('button', { name: '载入演示数据' }).click()
  await expect(page.locator('.notice.snackbar')).toContainText('演示数据已载入', {
    timeout: 20_000,
  })
  await page.getByRole('button', { name: /知识图谱/ }).click()
  await expect(page.locator('.graph-node')).toHaveCount(18)
}

/**
 * 采样所有节点的圆心坐标（顺序与渲染顺序一致，可以按下标比对）。
 * 资料节点还带一圈 halo，用 :not 排掉，否则同一个圆心会被采两次。
 */
function sampleNodes(page: Page) {
  return page.locator('.graph-node circle:not(.graph-node-halo)').evaluateAll((elements) =>
    elements.map((element) => [
      Number(element.getAttribute('cx')),
      Number(element.getAttribute('cy')),
    ] as [number, number]),
  )
}

async function waitUntilSettled(page: Page): Promise<[number, number][]> {
  let previous = await sampleNodes(page)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(200)
    const next = await sampleNodes(page)
    const still = next.every(
      ([x, y], index) =>
        Math.abs(x - previous[index]![0]) < 0.6 && Math.abs(y - previous[index]![1]) < 0.6,
    )
    previous = next
    if (still) {
      return next
    }
  }
  throw new Error('图谱一直没有收敛')
}

test('图谱会自己动起来，然后收敛到画布内且互不重叠', async ({ page }) => {
  await openGraphWithDemoData(page)

  const before = await sampleNodes(page)
  // 300ms 时应该还在动：既证明有动画，也证明它不是"一瞬间到位"的抽搐
  await page.waitForTimeout(300)
  const during = await sampleNodes(page)
  const moved = before.some(
    ([x, y], index) => Math.hypot(x - during[index]![0], y - during[index]![1]) > 1,
  )
  expect(moved, '进入图谱后节点应当在动').toBe(true)

  const settled = await waitUntilSettled(page)

  // 收敛后全部落在画布安全区内（布局自带 52 的内边距）
  for (const [x, y] of settled) {
    expect(x).toBeGreaterThan(45)
    expect(x).toBeLessThan(675)
    expect(y).toBeGreaterThan(45)
    expect(y).toBeLessThan(475)
  }

  // 圆半径 22：圆心间距必须大于直径，否则节点会糊成一团
  let minGap = Number.POSITIVE_INFINITY
  for (let i = 0; i < settled.length; i += 1) {
    for (let j = i + 1; j < settled.length; j += 1) {
      minGap = Math.min(minGap, Math.hypot(settled[i]![0] - settled[j]![0], settled[i]![1] - settled[j]![1]))
    }
  }
  expect(minGap, `最近的两个节点只差 ${minGap.toFixed(1)}px`).toBeGreaterThan(44)
})

test('图谱可以按学科分开看，切过去只保留那一簇', async ({ page }) => {
  await openGraphWithDemoData(page)

  const chips = page.locator('.graph-scope-chip')
  await expect(chips).toHaveCount(4)
  await expect(chips.nth(0)).toContainText('全部')
  await expect(chips.nth(1)).toContainText('数学')
  await expect(chips.nth(2)).toContainText('英语')
  await expect(chips.nth(3)).toContainText('物理')

  await chips.nth(3).click()
  await expect(page.locator('.graph-node:not(.dim)')).toHaveCount(6)
  await expect(page.locator('.graph-edge-group:not(.dim)')).toHaveCount(5)
  await expect(page.locator('.card-desc').first()).toContainText('6 个知识点 · 5 条关系')

  await chips.nth(0).click()
  await expect(page.locator('.graph-node:not(.dim)')).toHaveCount(18)
  await expect(page.locator('.card-desc').first()).toContainText('18 个知识点 · 15 条关系')
})

test('点一个节点只看它的一跳邻居，点空白恢复全部', async ({ page }) => {
  await openGraphWithDemoData(page)

  const documentNode = page.locator('.graph-node', { hasText: /高三数学错题/ })
  await expect(documentNode).toHaveCount(1)
  await documentNode.locator('circle:not(.graph-node-halo)').click()

  // 这份资料 + 它连出的 5 个知识点
  await expect(page.locator('.graph-node:not(.dim)')).toHaveCount(6)
  await expect(page.locator('.graph-hint')).toContainText('正在看')
  await expect(page.locator('.graph-detail')).toContainText('高三数学错题笔记.txt')

  await waitUntilSettled(page)
  await page.locator('.graph-stage svg').click({ position: { x: 12, y: 12 } })
  await expect(page.locator('.graph-node:not(.dim)')).toHaveCount(18)
  await expect(page.locator('.graph-hint')).toContainText('点一个节点')
})
