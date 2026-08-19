# DSH-Hotplug-Hub 统一 UI 开发标准

版本：1.0.0
适用：本项目全部 UI 面（Web GUI / 桌面 EXE 壳 / 安装向导 / CLI 文本）
更新日期：2026-08-19

> 目标：让整个项目（浏览器原型、WebView2 桌面壳、WinForms 安装向导、CLI 输出）呈现**同一套视觉语言**，杜绝各文件各自硬编码颜色导致的样式漂移。
> 原则：**单一事实来源（Single Source of Truth）** —— `prototype.html` 的 `:root` CSS 变量是唯一权威令牌表；C# / CLI 只能映射这组令牌，禁止发明新色值。

---

## 1. 覆盖范围（哪些是 UI）

| 面 | 文件 | 归类 |
|---|---|---|
| Web GUI（主界面） | `dsh-hotplug-hub/dsh-pack-hub/prototype.html` | **令牌源 + 组件实现** |
| 桌面 EXE 壳 | `release/src/Main.cs` | 复制令牌源 + 原生对话框 |
| 安装向导 | `installer/Setup.cs` | 原生 WinForms |
| CLI 文本 | `launcher/index.js` | 终端输出 |
| ~~历史 DSH client UI~~ | `dsh-hotplug-hub/lib/client.js` | 已弃用，**不修改** |

---

## 2. 设计令牌（Design Tokens）

### 2.1 色板 —— 唯一权威值

| 令牌 | 值 | C# Color | 用途 |
|---|---|---|---|
| `--teal` | `#0e7c6b` | `Color.FromArgb(14,124,107)` | 品牌主色 · 主按钮 · 激活态 |
| `--teal-dark` | `#0f2f2a` | `Color.FromArgb(15,47,42)` | 侧栏深青背景 |
| `--teal-soft` | `#dceeea` | `Color.FromArgb(220,238,234)` | 主色浅底（关键字/提示） |
| `--teal-hover` | `#0a6a5c` | `Color.FromArgb(10,106,92)` | 主按钮 hover |
| `--bg` | `#f1f2ec` | `Color.FromArgb(241,242,236)` | 页面背景 |
| `--panel` | `#fffef9` | `Color.FromArgb(255,254,249)` | 卡片/面板背景（暖白纸感） |
| `--ink` | `#17201d` | `Color.FromArgb(23,32,29)` | 主文字（墨绿黑） |
| `--muted` | `#66736e` | `Color.FromArgb(102,115,110)` | 次要文字 / 提示 |
| `--line` | `#d9ddd4` | `Color.FromArgb(217,221,212)` | 边框线 |
| `--sidebar-ink` | `#e7f0ec` | `Color.FromArgb(231,240,236)` | 侧栏文字（浅青白） |
| `--nav-ink` | `#d9e7e0` | `Color.FromArgb(217,231,224)` | 侧栏导航未选文字 |
| `--green` | `#1a7f4b` | `Color.FromArgb(26,127,75)` | 成功/健康 |
| `--amber` | `#b45309` | `Color.FromArgb(180,83,9)` | 警告 |
| `--red` | `#b3261e` | `Color.FromArgb(179,38,30)` | 错误/危险 |
| `--surface-dark` | `#10241f` | `Color.FromArgb(16,36,31)` | 深色面（日志框/Toast 底色） |
| `--surface-dark-ink` | `#cde8dd` | `Color.FromArgb(205,232,221)` | 深色面文字 |

软化态（浅底，已令牌化的为 `--green-soft #e7f5eb`、`--amber-soft #fbeede`、`--red-soft #fbe7e4`、`--neutral-soft #f0f2ec`、`--teal-soft #dceeea`，供 `.soft` 系列使用，不属于主色板）；组件内字面边框色：绿色 `#bfe0c6`、琥珀 `#efd3ae`、危险 `#e6b7b1`。

### 2.2 字体

| 令牌 | 栈 | 说明 |
|---|---|---|
| `--font-sans` | `ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` | 界面文字 |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | 代码/版本号/日志 |

C# 原生 UI 一律 `Font = new Font("Microsoft YaHei UI", 9F)`；标题/主按钮可用 `11F, FontStyle.Bold`。

### 2.3 圆角 · 间距 · 阴影 · 动效

| 令牌 | 值 | 应用 |
|---|---|---|
| `--rad-sm` | `6px` | 行内小元素（plugin-row） |
| `--rad` | `8px` | 卡片/按钮/面板/对话框（**默认**） |
| `--rad-lg` | `10px` | 徽章/开关/计数 |
| `--rad-full` | `20px` | Pill / Chip（胶囊） |
| 间距基数 | `4px` | 步进 4/8/12/14/16/18/22 |
| `--shadow-toast` | `0 8px 24px rgba(0,0,0,.2)` | Toast / 弹出层 |
| 动效 | `0.15–0.2s ease` | switch 平移 0.15s、toast 显隐 0.2s |

### 2.4 状态语义映射

| 状态 | 徽章底 | 文字 |
|---|---|---|
| ok / 健康 | `#e7f5eb` | `--green` |
| warn / 可更新 | `--amber-soft` | `--amber` |
| err / 冲突 | `--red-soft` | `--red` |
| neutral / 未装 | `--neutral-soft` | `--muted` |

---

## 3. 组件规范（prototype.html 为准）

> DOM 结构 + 关键样式，新增/重构任何界面必须复用这些类，不另起炉灶。

### 3.1 基础控件
- **按钮 `.btn`**：`display:inline-flex; gap:8px; padding:8px 12px; border:1px solid var(--line); border-radius:var(--rad); background:#fff; font-size:13px`
  - `.btn.primary` 主操作：`background:var(--teal); color:#fff`，hover `var(--teal-hover)`
  - `.btn.danger` 危险：文字 `var(--red)`，hover `var(--red-soft)`
  - `.btn.sm` 小型：`padding:5px 9px; font-size:12px`
  - 禁用：`opacity:.5; cursor:not-allowed`
  - 必须带图标时用 `ICONS.*`（17px SVG stroke 1.5/2 线型，lucide 风格），文字前插
- **胶囊按钮 `.chip`**：`border-radius:var(--rad-full); padding:6px 12px; font-size:12px`；选中 `.chip.on` → `background:var(--teal)`

### 3.2 状态元素
- **徽章 `.badge`**：`border-radius:var(--rad-lg); padding:3px 9px; font-size:11px; font-weight:600`，四种状态见 §2.4
- **Pill `.pill`**：`border-radius:var(--rad-full)`，`.good/.warn` 两种
- **标签 `.tag` / `.kw`**：`font-size:11px; border-radius:10px; padding:2px 8px`，`--tag` 中性底 / `--kw` 品牌浅底

### 3.3 容器
- **统计卡 `.stat`**：`background:var(--panel); border:1px solid var(--line); border-radius:var(--rad); padding:14px 16px`；`.label` 12px muted，`.num` 26px 700
- **包卡片 `.pack` / 记忆卡 `.mem`**：面板底 + 1px 线 + `--rad`；`.pack-icon` 38px 方形首字角标（背景 `accent`）
- **行 `.check-row` / `.plugin-row`**：`border-radius:var(--rad)`，name 13px 600 / desc 12px muted / val 等宽字体
- **面板 `.panel` / 工具栏 `.toolbar`**：面板底 + 1px 线 + `--rad`，padding 16/12
- **深色日志 `.log-box`**：`background:var(--surface-dark); color:var(--surface-dark-ink); font-family:var(--font-mono); border-radius:var(--rad)`，`.ok`→`#7fd6a8` `.warn`→`#f3c076`

### 3.4 交互围栏
- **开关 `.switch`**：42×24 圆角轨道，`--rad-full`，激活 `background:var(--teal)`；knob 18px 白，`box-shadow:0 1px 3px rgba(0,0,0,.25)`，平移 0.15s
- **对话框 `.dialog`**：`width:min(520px,100%); background:var(--panel); border-radius:var(--rad)`；背后 `.dialog-backdrop` 遮罩 `rgba(10,24,20,.45)`，z-index:30；`.actions` 右对齐
- **Toast `.toast`**：底部居中，`background:var(--surface-dark); color:#fff; border-radius:var(--rad); box-shadow:var(--shadow-toast)`，z-index:40，opacity 过渡 0.2s
- **搜索 `.search`**：1px 线 + `--rad` + 白色底，聚焦态（输入框 `.req-box`）`outline:2px solid var(--teal)`

### 3.5 布局
- 主骨架 `.app`：`grid-template-columns: 232px minmax(0,1fr)`，窄屏 `≤720px` 收为 `72px` 图标栏（隐藏品牌/文字/侧栏脚）
- 统计区 `.grid-4`：4 列 → `≤1000px` 2 列 → `≤720px` 1 列
- 包网格 `.pack-grid`：3 列 → 同理降级
- 顶部栏 `.topbar`：白面板底 + 下边框 + sticky，标题 18px / ctx 12px muted

---

## 4. 跨面一致性落地规则

### 4.1 Web（prototype.html）—— 令牌源
- 所有颜色/圆角/阴影**必须**从 `:root` 取 `var(--x)`，禁止字面量十六进制进入业务类。
- 新组件先加令牌，再写样式；改色只改 `:root`。

### 4.2 桌面壳（Main.cs）—— 借令牌，不复制
- 注入到页面的 `<style>`：**直接引用 `var(--teal)` / `var(--teal-hover)` / `var(--sidebar-ink)` 等**（因 `:root` 在同一个页面里），禁止带字面量十六进制。
- 原生 WinForms 对话框：集中到一个静态色板类（如 `DshTheme.Teal`/`Ink`/`Panel`/`Bg`），从 §2.1 表取值；所有对话框用 `DshTheme`，不散落 `Color.FromArgb`。
- 字体统一 `Microsoft YaHei UI`；窗口背景用 `DshTheme.Bg`（消除与 Web 白色闪屏差异）。

### 4.3 安装向导（Setup.cs）—— 独立色板但同值
- 新增 `Palette` 静态类，值严格取自 §2.1（teal / teal-hover / ink / panel）。
- 主按钮 `FlatStyle.Flat`，背景 `Palette.Teal`、前景白，与 `.btn.primary` 语义一致。
- 字体统一 `Microsoft YaHei UI`。

### 4.4 CLI（launcher/index.js）—— 文本风格协议
- 状态行用大写动词徽标：`ASSEMBLE OK` / `ASSEMBLE FAIL` / `CHECK OK` / `CONFLICTS:` / `HEAL OK` / `HEAL FAIL` / `LAUNCH OK` / `LAUNCH FAIL`。
- 失败走 `console.error`；成功走 `console.log`。
- 详情行统一两级缩进：顶层 `key:`，子项 `  - item`，冲突/自愈项 `  [code] ...`。
- 不引入 ANSI 转义（跨平台兼容），CI 只跑不断言输出。

---

## 5. 修改与验证流程

```
1. 改令牌 → 只改 prototype.html :root
2. 改 Web 界面 → prototype.html（浏览器直接打开 / 下方无头验证）
3. 改桌面壳 UI → Main.cs（注入样式用 var(--x)，原生对话框用 DshTheme）
4. 改安装向导 → Setup.cs（用 Palette）
5. 统一重新编译：
     pwsh -File release/build-exe.ps1          # 内嵌最新 prototype.html + Main.cs → EXE
     pwsh -File installer/build-installer.ps1  # 重打安装包
6. 验证清单见文末 §7
```

> 警告：EXE 内嵌的是**编译那一刻**的 `prototype.html` 快照（`build-exe.ps1` 的 `/resource:$protoHtml`）。只改 HTML 不重编译，桌面版不会变。

---

## 6. 命名与文案规范

- 品牌名统一 **「DSH 热插拔中枢」**（英文 DSH-Hotplug-Hub）；模块叫「插件中枢 / 插件包市场 / AI 组装 / 记忆中枢 / 自检更新」。
- 按钮动作动词开头：「刷新 / 导入包 / 一键安装 / 重新自检 / 更新 DSH」；确认类用「确认安装 / 卸载 / 下载并更新」。
- 对话框标题 = 动作对象；正文第一句说清"会发生什么"，末尾给结果预期（如「重启后生效」）。
- 代码/版本号/包名用等宽字体（mono），内容中的 `packId`、`version` 一律 `<code>` 或 `.val`。

---

## 7. 验收清单

- [ ] `prototype.html` 无字面量色值流入业务样式（全部 `var(--x)`）
- [ ] `Main.cs` 注入样式用 `var(--x)`；原生对话框用 `DshTheme`，无散落 `Color.FromArgb`
- [ ] `Setup.cs` 用 `Palette`，主按钮 = teal 底白字，标题 11F Bold teal
- [ ] CLI 状态词/缩进符合 §4.4
- [ ] `release/build-exe.ps1` 成功编译，EXE 内嵌 HTML 变化生效
- [ ] Edge 无头截图验证五大页签正常渲染、色板一致
```
