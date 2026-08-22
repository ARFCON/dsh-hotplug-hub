# DSH-Hotplug-Hub 统一 UI 组件标准 v2.0

版本：2.0.0
范围：项目全部 UI 面（Web GUI / 主程序 EXE 页 / 安装程序 / CLI 文本）
生效日期：2026-08-22

> **v2.0 变更摘要**（相对 v1.0）：
> - 布局由「左侧栏导航」改为「顶部横向导航」
> - 配色由「青绿 teal 系」改为「现代中性 + 深蓝强调」
> - 引入折叠式卡片（`.fold`）作为列表项标准形态
> - 状态由「文字 badge」改为「语义色圆点 `.status-dot`」+ 文字并存
> - 新增设计令牌：`--accent` / `--accent-soft` / `--nav-h` / `--ease` / `--dur`
>
> 目标：让「插件管理原型」「WebView2 主程序页」「WinForms 安装引导」「CLI 输出」共用**同一套视觉语言**，杜绝各文件各自为政的配色漂移。
> 原则：**单一实现源（Single Source of Truth）** —— `prototype.html` 的 `:root` CSS 变量是唯一权威色调，C# / CLI 只做映射，不写重复色值。

---

## 1. 哪些算「UI」？

| 层 | 文件 | 角色 |
|---|---|---|
| Web GUI（主界面） | `dsh-hotplug-hub/dsh-pack-hub/prototype.html` | **设计源 + 权威实现** |
| 主程序 EXE 页 | `release/src/Main.cs` | 注入样式 + 原生对话框 |
| 安装程序 | `installer/Setup.cs` | 原生 WinForms |
| CLI 文本 | `launcher/index.js` | 终端输出 |
| ~~历史 DSH client UI~~ | `dsh-hotplug-hub/lib/client.js` | 已废弃，**勿改** |

---

## 2. 设计令牌（Design Tokens）

### 2.1 颜色 —— 唯一权威值

| 令牌 | 值 | 用途 |
|---|---|---|
| `--accent` | `#2563eb` | 品牌强调色：主按钮 / 选中态 / 链接 |
| `--accent-strong` | `#1d4ed8` | 强调深色（hover） |
| `--accent-soft` | `#eff4ff` | 强调浅底（选中底 / 提示底） |
| `--accent-ink` | `#ffffff` | 强调色上的文字 |
| `--bg` | `#f6f7f9` | 页面背景（冷灰白） |
| `--panel` | `#ffffff` | 卡片 / 面板（纯白） |
| `--ink` | `#1a1f26` | 主文字（深墨） |
| `--muted` | `#6b7280` | 次要文字 / 提示 |
| `--line` | `#e5e7eb` | 边框线 |
| `--nav-ink` | `#6b7280` | 导航未选中文字 |
| `--green` | `#16a34a` | 成功 / 健康 |
| `--amber` | `#d97706` | 警告 |
| `--red` | `#dc2626` | 错误 / 危险 |
| `--surface-dark` | `#1f2937` | 深色面（日志 / Toast 深色底） |
| `--surface-dark-ink` | `#e5e7eb` | 深色面文字 |

状态浅底（`.soft` 系列）：`--green-soft #ecfdf5`、`--amber-soft #fffbeb`、`--red-soft #fef2f2`、`--neutral-soft #f3f4f6`、`--accent-soft #eff4ff`。

> **兼容别名**：`--teal` / `--teal-dark` / `--teal-soft` / `--teal-hover` 保留为历史别名，值映射到 `--accent` 系，避免大范围重写既有 CSS。新代码**一律写 `--accent`**。

### 2.2 字体

| 令牌 | 值 |
|---|---|
| `--font-sans` | `ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

C# 原生 UI：`Font = new Font("Microsoft YaHei UI", 9F)`，标题/按钮 `11F, FontStyle.Bold`。

### 2.3 圆角 · 间距 · 阴影 · 动效

| 令牌 | 值 | 应用 |
|---|---|---|
| `--rad-sm` | `6px` | 小组件（plugin-row） |
| `--rad` | `10px` | 卡片 / 按钮 / 输入框 / 对话框 **默认** |
| `--rad-lg` | `12px` | 标签 / 徽章 / 分组 |
| `--rad-full` | `999px` | Pill / Chip / 状态点 |
| `--nav-h` | `56px` | 顶部导航高度 |
| `--shadow-toast` | `0 8px 24px rgba(17,24,39,.18)` | Toast / 浮层 |
| `--ease` | `cubic-bezier(.4, 0, .2, 1)` | 统一缓动 |
| `--dur` | `.22s` | 统一过渡时长 |

动效约定：switch 平滑 `0.15s`，折叠展开 / toast / hover 用 `var(--dur) var(--ease)`。

### 2.4 状态色映射

| 状态 | 浅底 | 前景 |
|---|---|---|
| ok / 健康 | `--green-soft` | `--green` |
| warn / 可更新 | `--amber-soft` | `--amber` |
| err / 冲突 | `--red-soft` | `--red` |
| neutral / 未装 | `--neutral-soft` | `--muted` |

---

## 3. 布局规范（v2：顶部导航）

```
┌────────────────────────────────────────────────────┐
│ 品牌标识  │  页签导航（横向）   │  dsh 版本 · 待生效 │ ← .topnav 56px sticky
├────────────────────────────────────────────────────┤
│  页标题 + 上下文        [状态pill] [操作按钮]        │ ← .topbar sticky
├────────────────────────────────────────────────────┤
│                                                    │
│        内容区 .wrap（折叠卡片列表 / 网格）          │
│                                                    │
└────────────────────────────────────────────────────┘
```

- `.app`：`display:flex; flex-direction:column`
- `.topnav`：高 `var(--nav-h)`，白底 + 下边框，sticky top 0，z-index 20
- `.nav`：横向 flex，按钮选中态 = **底部 2px 强调色下划线**（非 pill 背景）
- `.topbar`：透明底，sticky top `var(--nav-h)`（叠在导航下方），页标题 + 状态 + 操作
- 内容区 `.wrap`：`padding:22px; display:grid; gap:18px`

### 3.1 导航按钮 `.nav button`
- 未选中：透明底 + `--nav-ink` 文字，无下划线
- hover：`--neutral-soft` 底 + `--ink` 文字
- 选中：`--accent` 文字 + 2px `--accent` 下边框，font-weight 600
- 计数 `.n-count`：`--neutral-soft` 圆底，选中时 `--accent-soft` 底 + `--accent` 字

---

## 4. 组件规范（以 prototype.html 为准）

### 4.1 折叠卡片 `.fold`（v2 核心组件）
列表项标准形态：**头部常显核心信息 + 高频开关，详情与低频操作折叠收起**。

```
<div class="fold">
  <div class="fold-head" data-fold-toggle>
    [图标] [标题+元信息] [状态点] [开关] [chevron]
  </div>
  <div class="fold-body">         ← grid-template-rows 0fr→1fr 过渡
    <div class="fold-inner">
      <div class="fold-content"> [详情 + 操作按钮] </div>
    </div>
  </div>
</div>
```

- `.fold-head`：`padding:13px 16px; cursor:pointer`，hover `--neutral-soft`
- `.fold-chevron`：随展开旋转 180°（`transition: transform var(--dur) var(--ease)`）
- 展开动画：`.fold-body` 用 `grid-template-rows: 0fr ↔ 1fr`（天然过渡，无需 JS 量高度）
- **交互隔离**：头部内的 `.switch` / `.btn` / 链接点击**不触发折叠**（全局委托里判断 `closest('.switch,.btn,...')`）

### 4.2 基础控件
- **按钮 `.btn`**：`inline-flex; gap:8px; padding:8px 12px; border:1px solid var(--line); border-radius:var(--rad); background:var(--panel); font-size:13px`
  - `.btn.primary`：`background:var(--accent); color:var(--accent-ink)`，hover `var(--accent-strong)`
  - `.btn.danger`：`color:var(--red)`，hover `var(--red-soft)`
  - `.btn.sm`：`padding:5px 9px; font-size:12px`
  - 禁用：`opacity:.5; cursor:not-allowed`
  - 图标用 `ICONS.*`（17px SVG stroke 1.5/2，lucide 风格）
- **胶囊按钮 `.chip`**：`border-radius:var(--rad-full); padding:6px 12px`，选中 `.chip.on` = `--accent` 底

### 4.3 状态元素
- **状态点 `.status-dot`**：8px 圆形，`.ok/.warn/.err/.neutral` 对应 2.4 色（v2 新引入，替代纯文字 badge 的单调）
- **徽章 `.badge`**：`border-radius:var(--rad-lg); padding:3px 9px; font-size:11px; font-weight:600`
- **Pill `.pill`**：`border-radius:var(--rad-full)`，`.good/.warn`
- **标签 `.tag` / `.kw`**：`font-size:11px; border-radius:var(--rad-lg); padding:2px 8px`

### 4.4 容器
- **统计卡 `.stat`**：`background:var(--panel); border:1px solid var(--line); border-radius:var(--rad); padding:14px 16px`，`.label` 12px muted / `.num` 26px 700
- **卡片 `.pack` / `.mem`**：白底 + 1px 线 + `--rad`（列表项统一用 `.fold` 替代）
- **行 `.check-row` / `.plugin-row`**：`border-radius:var(--rad)`，name 13px 600 / desc 12px muted / val 等宽字体
- **面板 `.panel` / 工具栏 `.toolbar`**：白底 + 1px 线 + `--rad`，padding 16/12
- **深色日志 `.log-box`**：`background:var(--surface-dark); color:var(--surface-dark-ink); font-family:var(--font-mono)`，`.ok #34d399` `.warn #f59e0b`

### 4.5 交互组件
- **开关 `.switch`**：42×24，`--rad-full`，开 = `--accent` 底，knob 18px 白，`box-shadow:0 1px 3px rgba(0,0,0,.25)`，过渡 0.15s
- **对话框 `.dialog`**：`width:min(520px,100%); background:var(--panel); border-radius:var(--rad)`，backdrop `rgba(17,24,39,.45)` z-index 30
- **Toast `.toast`**：底部居中，`background:var(--surface-dark); color:#fff`，z-index 40，opacity 过渡 0.2s
- **输入 `.search`**：1px 线 + `--rad` + 白底，聚焦 `outline:2px solid var(--accent)`

---

## 5. 主题系统（换肤）

- 主题通过 `documentElement.style.setProperty()` 动态覆盖 `:root` 变量实现，实时预览，无需重载
- 预设皮肤 4 套：深色 / 青色 / 琥珀 / 翠绿（`THEME_PRESETS`）
- 自定义皮肤：用户调色后命名保存（`custom:<name>`），持久化于 `state.theme.skins`
- 启动时 `applyTheme()` 恢复上次皮肤

---

## 6. 实现与验证流程

```
1. 改颜色 —— 只改 prototype.html 的 :root（新代码用 --accent，别写死十六进制）
2. 改 Web 界面 —— prototype.html，浏览器直接打开 / 加 headless 验证
3. 改主程序 UI —— Main.cs 注入样式用 var(--x)；原生对话框用 DshTheme 静态类
4. 改安装程序 —— Setup.cs 用 Palette 静态类
5. 统一重新打包：
     pwsh -File release/build-exe.ps1          # 内嵌新版 prototype.html + Main.cs
     pwsh -File installer/build-installer.ps1  # 重建安装包
6. 验证清单（见 §7）
```

> 警告：EXE 内嵌的是**构建那一刻**的 `prototype.html` 快照（`build-exe.ps1` 的 `/resource:$protoHtml`）。改了 HTML 后必须重新构建，否则界面不变。

---

## 7. 交付清单

- [ ] `prototype.html` 全部硬编码色值收敛到 `var(--x)`
- [ ] `Main.cs` 注入样式用 `var(--x)`；原生对话框用 `DshTheme`，无散落 `Color.FromArgb`
- [ ] `Setup.cs` 用 `Palette`，主按钮 = accent 白字，标题 11F Bold
- [ ] CLI 状态词/文案对齐 §6 文案规范
- [ ] `release/build-exe.ps1` 编译成功，EXE 内嵌 HTML 变化生效
- [ ] 浏览器 / headless 验证：顶部导航渲染、折叠展开、主题切换正常
