#!/usr/bin/env node
// Material Icons as inline SVG paths, the same glyphs as Compose Icons.Rounded / Filled / Outlined...
//
//   cd PWA/web && npm i -D @material-design-icons/svg@0.14.15
//   node <skill>/scripts/material_icons.mjs --style round --out src/lib/icons.gen.ts \
//        arrow_back add settings delete home=home food=restaurant car=directions_car
//
// "name" goes into uiIcons (icons used by the screens, typed as UiIcon).
// "key=name" goes into appIcons: icon keys the native app stores in its database (category icons...),
// mapped to the Material glyph the native app shows for that key.
// Compose name to Material file name: Icons.Rounded.ArrowBack -> arrow_back, Icons.Rounded.AddCircle -> add_circle.
// Styles: round (Icons.Rounded), filled (Icons.Filled), outlined, sharp, two-tone.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
let style = 'round'
let out = 'src/lib/icons.gen.ts'
const names = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--style') style = args[++i]
  else if (args[i] === '--out') out = args[++i]
  else names.push(args[i])
}

const base = join(process.cwd(), 'node_modules', '@material-design-icons', 'svg', style)
const ui = {}
const app = {}
const missing = []
for (const entry of names) {
  const [key, file] = entry.includes('=') ? entry.split('=') : [entry, entry]
  let svg
  try {
    svg = readFileSync(join(base, `${file}.svg`), 'utf8')
  } catch {
    missing.push(file)
    continue
  }
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim()
  ;(entry.includes('=') ? app : ui)[key] = inner
}

const label = { round: 'Rounded', filled: 'Filled', outlined: 'Outlined', sharp: 'Sharp', 'two-tone': 'TwoTone' }[style] ?? style
const body = `// Generated from Material Icons (${label}), the same set as Compose Icons.${label}. Apache License 2.0.
// Regenerate with material_icons.mjs; render as <svg viewBox="0 0 24 24" fill="currentColor"> with this markup inside.

/** Icon keys stored in the database, as in the native app. */
export const appIcons: Record<string, string> = ${JSON.stringify(app, null, 2)}

/** Icons used by the screens. */
export const uiIcons = ${JSON.stringify(ui, null, 2)} as const

export type UiIcon = keyof typeof uiIcons
`
writeFileSync(out, body)
console.log(`${Object.keys(ui).length} UI icons, ${Object.keys(app).length} app icons -> ${out}`)
if (missing.length) {
  console.error(`Not found in ${style}: ${missing.join(', ')}`)
  process.exit(1)
}
