// install-plugins.mjs — 跨平台安装 dsh-memory-hub 到本地 DeepSeek Harness
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const home = os.homedir()
const pluginSrc = path.join(home, '.dsh', 'plugin-src', 'dsh-memory-hub')
const src = path.join(root, 'dsh-hotplug-hub', 'dsh-memory-hub')

function copyDir(s, t) {
  fs.mkdirSync(t, { recursive: true })
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const a = path.join(s, e.name), b = path.join(t, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

if (!fs.existsSync(src)) { console.log('skip: dsh-memory-hub not found'); process.exit(0) }
if (fs.existsSync(pluginSrc)) fs.rmSync(pluginSrc, { recursive: true, force: true })
copyDir(src, pluginSrc)
console.log('installed:', pluginSrc)

const profileRoot = path.join(home, '.dsh', 'profiles')
let profile = null
if (fs.existsSync(profileRoot)) {
  for (const name of ['web', 'desktop', 'cc-tui', 'headless']) {
    const dir = path.join(profileRoot, name)
    if (fs.existsSync(path.join(dir, 'package.json'))) { profile = dir; break }
  }
}
if (!profile) { console.log('no profile found'); process.exit(0) }
const patch = path.join(profile, 'cordis.patch.yml')
if (!fs.existsSync(patch)) { console.log('no patch'); process.exit(0) }
let text = fs.readFileSync(patch, 'utf8')
if (!text.includes("name: 'dsh-memory-hub'")) {
  text = text.trimEnd() + "\n- insert:\n    - id: memory-hub\n      name: 'dsh-memory-hub'\n      config: { \"hubDir\": null, \"writePolicy\": \"ask\", \"snapshotOrder\": -50 }\n"
  fs.writeFileSync(patch, text, 'utf8')
  console.log('registered:', patch)
} else {
  console.log('already registered')
}
