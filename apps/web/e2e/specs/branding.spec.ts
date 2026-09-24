import { test, expect } from '@playwright/test'
import { onboard } from './helpers'

test('品牌图标出现在标签页、引导页和侧栏', async ({ page, request }) => {
  await page.goto('/')
  // 允许带 ?v=N 的缓存参数：换图标时靠它让浏览器重新拉
  const iconLink = page.locator('link[rel="icon"]')
  await expect(iconLink).toHaveAttribute('href', /^\/icon\.jpg(\?v=\d+)?$/)

  const icon = await request.get((await iconLink.getAttribute('href'))!)
  expect(icon.ok()).toBe(true)
  expect(icon.headers()['content-type']).toContain('image/jpeg')

  const onboardingLogo = page.locator('.profile-logo img')
  await expect(onboardingLogo).toBeVisible()
  await expect(onboardingLogo).toHaveJSProperty('complete', true)
  expect(await onboardingLogo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

  await onboard(page)
  const sidebarLogo = page.locator('.brand-mark img')
  await expect(sidebarLogo).toBeVisible()
  await expect(sidebarLogo).toHaveJSProperty('complete', true)
  expect(await sidebarLogo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
})
