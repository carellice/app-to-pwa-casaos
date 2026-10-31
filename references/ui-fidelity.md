# UI fidelity: theme, type, motion, components, navigation

Contents: 1 Stack · 2 Units · 3 Theme · 4 Typography · 5 Motion · 6 Seeded randomness · 7 Icons ·
8 Components · 9 Navigation · 10 Overlays · 11 Gestures and haptics · 12 Layout shell · 13 Pitfalls

## 1. Stack (pinned, known to work together)

`react@18.3.1`, `react-dom@18.3.1`, `framer-motion@11.18.2`, `vite@5.4.21`,
`@vitejs/plugin-react@4.7.0`, `typescript@5.6.3`, `@types/react@18.3.12`, `@types/react-dom@18.3.1`.
Optional: `jspdf@2.5.2` (lazy `import()`), `@material-design-icons/svg@0.14.15` (dev, icon generation).
No UI kit: every component is hand-built to match the native one. A UI kit would fight the look.

## 2. Units

- Compose `dp` → CSS `px` 1:1. `sp` → px 1:1 for layout; text may need a uniform scale factor so
  the rendered size matches the phone (Money used `.t-*` classes at ×1.1 after comparing
  screenshots). Decide the factor once, by comparing one screen, then apply it everywhere.
- Raw pixels in native code (Canvas, `graphicsLayer { translationX = 12f }`) are device pixels:
  divide by the density of the reference device (`const PX = 1 / 2.75`).
- iOS points → CSS px 1:1.

## 3. Theme

- Every color token becomes a CSS variable on `:root` (`--bg`, `--surface`, `--ink`, `--inkSoft`,
  `--accent`, `--accentText`...), written by an `applyTheme(colors)` function from a TS object that
  mirrors `Color.kt`. Light/dark: same token names, two palettes; theme mode SYSTEM/LIGHT/DARK
  stored per device; SYSTEM follows `matchMedia('(prefers-color-scheme: dark)')` via
  `useSyncExternalStore`. Also set `document.documentElement.style.colorScheme`.
- Colors stored as ARGB ints in the database (Compose `Color.toArgb()`): keep ints in the data and
  convert with an `argb(int)` helper (`#RRGGBB` / `rgba()`), never re-encode.
- Derived colors (text on accent, tinted surfaces): port the native helper exactly (e.g.
  `ColorUtils.colorToHSL` → HSL math in TS) instead of approximating with CSS `color-mix`.
- `<meta name="theme-color">` twice (light/dark media) and the manifest `background_color`, so the
  status bar and splash match.

## 4. Typography

- Ship the same font file in `web/public`; `@font-face` with `font-display: block` (no flash of the
  fallback font), `<link rel="preload" as="font" crossorigin>` in index.html.
- Variable fonts: map Compose `FontVariation` settings to `font-variation-settings` / `font-weight`
  / `font-stretch`.
- One CSS class per native text style (`.t-display`, `.t-title`, `.t-body`, `.t-label`,
  `.t-caption`...) with size, weight, line-height, letter-spacing taken from `Type.kt`.
- Numbers: `font-variant-numeric: tabular-nums` where the native uses tabular figures.
- Currency/units next to big numbers: adjust `line-height` (e.g. 1.15) so glyphs align like on the phone.
- Locale formatting: `Intl.NumberFormat(locale, { useGrouping: 'always' })` (Italian otherwise
  drops the thousands separator for 4-digit numbers, unlike Android).

## 5. Motion

Put the helpers in `components/motion.ts` (template provided):

```ts
type Spring = { type: 'spring'; stiffness: number; damping: number; mass: number }
type Tween = { type: 'tween'; duration: number; ease: [number, number, number, number] | 'linear' }
export function spring(dampingRatio = 1, stiffness = 1500): Spring {
  return { type: 'spring', stiffness, damping: 2 * dampingRatio * Math.sqrt(stiffness), mass: 1 }
}
```

- **Compose `spring(dampingRatio, stiffness)`** → framer spring with `damping = 2·ratio·√stiffness`, mass 1.
  Compose constants: `Spring.StiffnessHigh 10000`, `Medium 1500`, `MediumLow 400`, `Low 200`,
  `VeryLow 50`; `DampingRatioNoBouncy 1`, `LowBouncy 0.75`, `MediumBouncy 0.5`, `HighBouncy 0.2`.
  Default `spring()` = ratio 1, stiffness 1500. `animate*AsState` without spec = default spring.
- **SwiftUI `.spring(response:dampingFraction:)`** → stiffness = (2π/response)², damping =
  4π·dampingFraction/response (mass 1). `.easeInOut(duration:)` → tween with [0.42,0,0.58,1].
- **Compose easings**: `FastOutSlowInEasing` [0.4,0,0.2,1] (default for `tween`),
  `LinearOutSlowInEasing` [0,0,0.2,1], `FastOutLinearInEasing` [0.4,0,1,1], `LinearEasing` 'linear',
  `EaseOutBack` etc. from `androidx.compose.animation.core.Easing.kt`. Default `tween()` = 300 ms.
- **`AnimatedVisibility` defaults**: enter = `fadeIn() + expandIn()`, exit = `fadeOut() + shrinkOut()`
  with spring specs; replicate with `AnimatePresence` + `initial/animate/exit`, `height: 'auto'` for
  expand/shrink (wrap in `overflow: hidden`).
- **`AnimatedContent`** → `AnimatePresence mode="wait"` (or `popLayout`) keyed by the content.
- **Infinite transitions** (breathing buttons, wobbling shapes) → `repeat: Infinity,
  repeatType: 'reverse'`, or a shared `requestAnimationFrame` clock for many elements at once
  (one `onFrame` subscription list instead of one rAF per element).
- **Number rolls** (`animateFloatAsState` on amounts) → `useMotionValue` + `animate()` +
  `useTransform` to the formatted string.
- **Staggered lists** → per-item `transition.delay = index * step`, capped.
- **Press feedback**: Compose `Modifier.clickable` with a scale on press → a `Bouncy` component using
  `whileTap={{ scale: 0.96 }}` with the same spring; disable the ripple/highlight
  (`-webkit-tap-highlight-color: transparent`).
- Reduce motion: respect `prefers-reduced-motion` only if the native app respects the system setting.

## 6. Seeded randomness (shapes, confetti, avatars)

If the native code builds shapes from `Random(seed)`, the PWA must use the same generator to get the
same shapes: `assets/template/web/src/lib/kotlinRandom.ts` is Kotlin's `XorWowRandom` bit for bit
(`nextInt`, `nextFloat`, `nextDouble`, `nextBoolean`, `nextIntBetween(from, until)`) plus Java's
`String.hashCode`. Verified against kotlin-stdlib 2.0.21: seed 42 → `972016666 0.405260 1 7 2
0.15133156 true`, `"Netflix".hashCode() = -787338382`. `java.util.Random` is a different LCG: port
it separately if the app uses it (seed scramble `(seed ^ 0x5DEECE66D) & ((1<<48)-1)`; use BigInt).

Draw shapes as SVG paths regenerated per frame from a shared clock; port the native path math
(Catmull-Rom, cubic) literally, including rotation and phase offsets.

## 7. Icons

- Material icons (Compose `Icons.Rounded.X`, `Icons.Filled.X`): generate inline SVG paths with
  `scripts/material_icons.mjs` from `@material-design-icons/svg` (same glyphs). Render
  `<svg viewBox="0 0 24 24" fill="currentColor" dangerouslySetInnerHTML={{__html: paths}}/>`.
- Icon keys stored in the database (category icons...) keep the native keys; map key → glyph in
  `appIcons`, exactly as the native `when(key)` does.
- SF Symbols (iOS) have no free web copy: pick the closest Material glyph and list it in PORTING.md.
- Brand logos: Simple Icons (CC0) paths, or the native app's own drawables converted to SVG.

## 8. Components

Port each native component once into `components/ui.tsx` and reuse it: `Icon`, `Bouncy`
(pressable with scale), `PrimaryButton`, `Pill`/`Chip`, `Segmented`, `Switch`/`SwitchRow`,
`TextField`/`AmountField` (inputmode, autocomplete attributes for password managers:
`username`, `current-password`, `new-password`), `TopBar`, `SoftCard`, `SectionTitle`,
`EmptyState`, `ProgressBar`, `ColorSwatches`, `IconPicker`, charts (SVG: donut with animated arcs,
bars, calendar heatmap), list rows with swipe-to-delete (`drag="x"` with thresholds and a reveal
background) and snackbar undo.

Charts: draw with SVG, animate `pathLength`/arc angles with the same spring; don't pull a chart
library, it will not match.

## 9. Navigation (template `web/src/lib/nav.ts`)

- A back stack of `{ key, route, params }` mirrored in `history.pushState({ depth })`, so the
  Android back gesture, the iOS swipe and the browser back button pop the stack.
- `topLevel` routes are tabs: switching replaces the tab above Home (`history.replaceState`);
  re-selecting Home scrolls it to top (`homeReselect` event).
- `useBackHandler(enabled, handler)` = Compose `BackHandler`: a screen can consume back (close a
  sheet, go to the previous step of a wizard).
- The `programmatic` flag: when the app itself calls `back()` (after saving), back handlers are
  skipped. Without it, a wizard's step handler swallows the close and the form "goes back a step".
- Layers: each stack entry renders in an absolutely positioned `.layer`; entering/leaving animate
  like the native transitions (slide from right for push, from bottom for `sheetRoutes`, fade+scale
  for tabs). Keep the previous layer mounted under the top one during the animation.
- Deep links: `/?route=...&id=...` from notifications and manifest shortcuts (`openDeepLink`), and
  the service worker posts `{type:'open', url}` to an already open window.

## 10. Overlays

- Everything floating (bottom sheets, dialogs, date pickers, image preview, snackbars, toasts)
  renders through a portal into `#overlays`, a sibling of the app root, so it is never clipped by a
  layer's `overflow`.
- Bottom sheet: `drag="y"` with `dragControls` started from the handle/top area, dismiss past a
  threshold or velocity, scrim fade, spring in (ratio 1, stiffness 400), tween out 250 ms; registers
  a back handler.
- Snackbar with undo: delayed commit (e.g. delete image only when the undo window passes).

## 11. Gestures and haptics

- `navigator.vibrate(8)` for `HapticFeedbackType.ContextClick`-like ticks, 25 ms for long press
  (Android only; iOS Safari ignores it — fine).
- `touch-action: manipulation` (no double-tap zoom), `overscroll-behavior: none`, `user-select:
  none` except inputs.
- Long press: pointer timers (~450 ms), cancel on move.

## 12. Layout shell

- `index.html`: `viewport-fit=cover, interactive-widget=resizes-content`; safe areas via
  `env(safe-area-inset-top/bottom)` into `.status-pad` / `.nav-pad` classes.
- `.app { max-width: 520px; margin: 0 auto; overflow: clip }`: phone proportions on desktop.
- Every screen: a column with a fixed top bar and a `.scroll` area (`overflow-y: auto`,
  `-webkit-overflow-scrolling: touch`), bottom padding for the bottom bar + safe area.

## 13. Pitfalls

- **SVG has no `offsetWidth`**: a component that measures itself to draw a path must measure
  `parentElement` (ResizeObserver on the parent).
- **Invisible overlays eat taps**: a full-size container that only positions a floating button
  needs `pointer-events: none` and the button `pointer-events: auto`.
- **`overflow: hidden` + focus/scrollIntoView shifts the app**: use `overflow: clip`.
- **framer-motion types**: helpers returning `Transition` unions break `transition=` props in TS;
  return the explicit `Spring`/`Tween` object types.
- **Hover styles stick on touch**: wrap hover rules in `@media (hover: hover)`.
- **100vh on mobile** includes browser chrome: use `height: 100%` chains from `html, body, #root`.
- **Inputs zoom on iOS** when font-size < 16 px: keep input text ≥ 16 px.
