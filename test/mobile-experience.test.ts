import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

describe('Mobile Experience Architecture Pass for EYE', () => {
  const root = path.resolve(process.cwd())

  test('1. Layout has complete PWA & viewport metadata with safe-area support', () => {
    const layoutPath = path.join(root, 'app/layout.tsx')
    const layout = fs.readFileSync(layoutPath, 'utf8')
    assert.match(layout, /viewportFit:\s*'cover'/, 'layout.tsx must specify viewportFit cover for notch/safe-area')
    assert.match(layout, /appleWebApp:\s*\{[^}]*capable:\s*true/, 'appleWebApp must be capable')
    assert.match(layout, /statusBarStyle:\s*'black-translucent'/, 'appleWebApp must use black-translucent')
    assert.match(layout, /themeColor:\s*'#090A0C'/, 'themeColor must match Savvy dark surface')
  })

  test('2. CSS has safe-area root tokens and mobile breakpoint rules', () => {
    const cssPath = path.join(root, 'app/globals.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    assert.match(css, /--sat:\s*env\(safe-area-inset-top/, 'CSS must declare --sat token')
    assert.match(css, /--sab:\s*env\(safe-area-inset-bottom/, 'CSS must declare --sab token')
    assert.match(css, /@media\s*\(max-width:\s*767px\)/, 'CSS must have dedicated <= 767px mobile media query')
    assert.match(css, /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1023px\)/, 'CSS must have tablet query')
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'CSS must support prefers-reduced-motion')
  })

  test('3. Shell provides compact mobile header and mobile filter action sheet', () => {
    const shellPath = path.join(root, 'app/(main)/shell.tsx')
    const shell = fs.readFileSync(shellPath, 'utf8')
    assert.match(shell, /mobile-filter-rail/, 'shell.tsx must include mobile-filter-rail')
    assert.match(shell, /m-chip/, 'shell.tsx must render mobile filter chips')
    assert.match(shell, /mobileFilterSheet/, 'shell.tsx must handle mobileFilterSheet modal state')
    assert.match(shell, /mobile-sheet-panel/, 'shell.tsx must render bottom filter action sheet')
    assert.match(shell, /desktop-filter-selects/, 'shell.tsx must preserve desktop SavvySelect filters')
  })

  test('4. Field Control implements native 3-state bottom sheet for mobile', () => {
    const fcPath = path.join(root, 'components/FieldControlPanel.tsx')
    const fc = fs.readFileSync(fcPath, 'utf8')
    assert.match(fc, /mobileSheetState,\s*setMobileSheetState/, 'FieldControlPanel must maintain 3-state mobileSheetState')
    assert.match(fc, /state-'\s*\+\s*mobileSheetState/, 'FieldControlPanel must apply mobile sheet state class')
    assert.match(fc, /fcm-handle-bar/, 'FieldControlPanel must provide mobile drag handle bar')
    assert.match(fc, /fcm-handle-pill/, 'FieldControlPanel must provide drag handle pill')
    assert.match(fc, /fcm-nav-grid/, 'FieldControlPanel must render thumb-friendly mobile navigation')
    assert.match(fc, /onTouchStart/, 'FieldControlPanel must support touch gesture interactions')
    assert.match(fc, /onTouchEnd/, 'FieldControlPanel must support touch gesture interactions')
  })

  test('5. Client detail panel slides up as full-height sheet on mobile with phone call link', () => {
    const spPath = path.join(root, 'components/SidePanel.tsx')
    const sp = fs.readFileSync(spPath, 'utf8')
    assert.match(sp, /sp-handle-bar/, 'SidePanel must have drag handle bar for mobile sheet')
    assert.match(sp, /sp-handle-pill/, 'SidePanel must have drag handle pill')
    assert.match(sp, /tel:\$\{field\('phone'\)\}/, 'SidePanel must support direct tel: dialing link on mobile')

    const cssPath = path.join(root, 'app/globals.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    assert.match(css, /\.side-panel\s*\{[^}]*height:\s*90dvh/, 'SidePanel on mobile must use near full-height dvh')
  })

  test('6. Visits workspace has compact mobile list and floating add visit CTA', () => {
    const rvPath = path.join(root, 'components/RouteView.tsx')
    const rv = fs.readFileSync(rvPath, 'utf8')
    assert.match(rv, /mobile-sticky-add-btn/, 'RouteView must include mobile-sticky-add-btn')
    assert.match(rv, /openVisitModal\(v\.id,\s*v\.visit_date/, 'Visit rows must be clickable to open modal')
  })

  test('7. AI Chat transforms into full-screen mobile conversational layer with keyboard safety', () => {
    const aiPath = path.join(root, 'components/AIChat.tsx')
    const ai = fs.readFileSync(aiPath, 'utf8')
    assert.match(ai, /ai-handle-bar/, 'AIChat must include mobile handle bar')
    assert.match(ai, /ai-handle-pill/, 'AIChat must include mobile handle pill')

    const cssPath = path.join(root, 'app/globals.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    assert.match(css, /\.ai-panel\s*\{[^}]*height:\s*100dvh/, 'AI panel on mobile must use 100dvh for keyboard safety')
    assert.match(css, /\.ai-fab\s*\{[^}]*bottom:\s*calc\(60px\s*\+\s*var\(--sab\)\)/, 'AI fab must float above collapsed bottom sheet')
  })

  test('8. Login page uses 100dvh and prevents mobile horizontal overflow', () => {
    const loginPath = path.join(root, 'app/login/login-form.tsx')
    const login = fs.readFileSync(loginPath, 'utf8')
    assert.match(login, /min-h-\[100dvh\]/, 'login-form must use min-h-[100dvh]')
    assert.match(login, /overflow-x-hidden/, 'login-form must prevent horizontal overflow')
  })
  test('9. Desktop and mobile SavvySelect filter display modes cannot visually coexist', () => {
    const selectPath = path.join(root, 'components/SavvySelect.tsx')
    const select = fs.readFileSync(selectPath, 'utf8')
    assert.match(select, /!isMobile &&/, 'SavvySelect must conditionally render desktop dropdown only when !isMobile')
    assert.match(select, /isMobile &&/, 'SavvySelect must conditionally render mobile sheet only when isMobile')
    assert.match(select, /savvy-select-opened/, 'SavvySelect must implement mutual exclusion coordinator')
    assert.match(select, /e.key === 'Escape'/, 'SavvySelect must implement global Escape key handler')

    const cssPath = path.join(root, 'app/globals.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    assert.match(css, /@media\s*\(min-width:\s*768px\)[^{]*\{[^}]*\.savvy-mobile-sheet-portal[^}]*display:\s*none\s*!important/, 'Desktop media query must hide mobile sheet with !important')
    assert.match(css, /@media\s*\(max-width:\s*767px\)[^{]*\{[^}]*\.savvy-select-dropdown[^}]*display:\s*none\s*!important/, 'Mobile media query must hide desktop dropdown with !important')
    assert.match(css, /\.savvy-select-wrap\.is-open\s*\{[^}]*z-index:\s*650/, 'Open SavvySelect wrap must elevate z-index to 650')
  })
})
