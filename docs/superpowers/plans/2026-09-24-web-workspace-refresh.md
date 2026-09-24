# Web Workspace Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 端所有导航页面沿用引导页的深海军蓝、暖白和清晰的编辑式排版，并保持现有操作不变。

**Architecture:** 沿用 `apps/web/src/styles.css` 的功能样式，修改全局色彩变量，另在 `apps/web/src/workspace.css` 放置仅作用于应用外壳的主题布局。新增轻量 `PageIntro` 展示各页标题，状态和数据仍由原页面负责；小程序及 `packages/core` 不修改。

**Tech Stack:** React 18, CSS, Vite, Playwright.

---

### Task 1: 共享设计契约与导航

**Files:**
- Create: `apps/web/e2e/specs/workspace.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Create: `apps/web/src/workspace.css`
- Modify: `apps/web/src/main.tsx`

- [x] **Step 1: Write the failing test**

```ts
test('导航栏采用深色设计并保留六个入口', async ({ page }) => {
  await onboard(page)
  await expect(page.locator('.nav-item')).toHaveCount(6)
  expect(await page.locator('.sidebar').evaluate((node) =>
    getComputedStyle(node).backgroundColor)).toBe('rgb(29, 38, 57)')
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config e2e/playwright.config.ts specs/workspace.spec.ts`
Expected: FAIL because the sidebar currently has a light background.

- [x] **Step 3: Implement the design**

Set `--brand: #176e66`, `--brand-hover: #10564f`, `--warm-bg: #f5f6f2` in `styles.css`. In `workspace.css` style `.app-shell`, `.sidebar`, `.nav-item`, `.chat-header`, `.mine-card` with ink navigation, warm surfaces and teal interactions; under `@media (max-width: 760px)` restore a readable light mobile bottom bar. Add `import './workspace.css'` after the existing stylesheet import. Keep all navigation buttons and callback wiring unchanged.

- [x] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config e2e/playwright.config.ts specs/workspace.spec.ts`
Expected: PASS with six functioning navigation entries.

### Task 2: Consistent Page Introductions

**Files:**
- Create: `apps/web/src/components/PageIntro.tsx`
- Modify: `apps/web/src/pages/Plan.tsx`
- Modify: `apps/web/src/pages/Assignments.tsx`
- Modify: `apps/web/src/pages/Documents.tsx`
- Modify: `apps/web/src/pages/Timetable.tsx`
- Modify: `apps/web/src/pages/Mine.tsx`
- Modify: `apps/web/src/pages/Graph.tsx`
- Modify: `apps/web/src/pages/Chat.tsx`
- Modify: `apps/web/e2e/specs/workspace.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
for (const [nav, heading] of [['计划', '学习计划'], ['作业', '作业清单'],
  ['资料库', '学习资料'], ['课程表', '课程安排'], ['我的', '我的空间']] as const) {
  await page.getByRole('button', { name: nav, exact: true }).click()
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config e2e/playwright.config.ts specs/workspace.spec.ts`
Expected: FAIL because most pages currently have no main heading.

- [x] **Step 3: Implement shared component and page headings**

```tsx
interface PageIntroProps {
  eyebrow: string
  title: string
  description: string
}
export default function PageIntro({ eyebrow, title, description }: PageIntroProps) {
  return <header className="workspace-intro">
    <span className="workspace-eyebrow">{eyebrow}</span>
    <h1>{title}</h1>
    <p>{description}</p>
  </header>
}
```

Use the component on each page before existing cards. Preserve existing card titles, test selectors, buttons, and data. The conversation page already has an `h1`; refine its welcome and header styling rather than adding another one. Style the intro, empty states, graph stage, metrics and composer in `workspace.css`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config e2e/playwright.config.ts specs/workspace.spec.ts`
Expected: PASS, including graph entry and back navigation.

### Task 3: Regression and Responsive Acceptance

**Files:**
- Modify: `apps/web/e2e/specs/workspace.spec.ts`
- Modify: `apps/web/src/workspace.css`

- [x] **Step 1: Write the failing narrow viewport check**

```ts
await page.setViewportSize({ width: 375, height: 760 })
await onboard(page)
await page.getByRole('button', { name: '资料库', exact: true }).click()
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
await expect(page.getByRole('heading', { name: '学习资料' })).toBeVisible()
```

- [x] **Step 2: Run the new check**

Run: `npx playwright test --config e2e/playwright.config.ts specs/workspace.spec.ts`
Expected: FAIL for any horizontal overflow or missing mobile heading.

- [x] **Step 3: Resolve overflow and focus accessibility**

Constrain content widths using `minmax(0, 1fr)` and `width: min(..., calc(100% - ...))`; style visible focus for sidebar, tabs and controls, and respect the existing reduced-motion media rule.

- [x] **Step 4: Verify all behavior**

Run: `npm run typecheck --workspace @synapse/web`, `npm run build --workspace @synapse/web`, `npm test`, and `npm run e2e --workspace @synapse/web`.
Expected: all TypeScript, build, core tests and Web e2e tests pass. Inspect fresh desktop/mobile screenshots for dialogue, plan, documents, assignments, timetable, profile and graph.

No commits are part of this plan because the user did not request one.
