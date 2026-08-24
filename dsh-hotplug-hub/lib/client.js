window.__ModuleLoader__.load({
	id: "dsh-hotplug-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useEffect, useRef, useState } = react;
		const css = ".hp_section{width:100%;max-width:860px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}.hp_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px;flex-direction:column;gap:8px;display:flex;min-width:0}.hp_heading{display:flex;align-items:baseline;gap:7px;margin:0}.hp_heading h3{margin:0;font-size:13px;font-weight:600;line-height:20px}.hp_heading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}.hp_info{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.hp_bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.hp_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;height:34px;padding:0 14px;font-size:13px}.hp_btn:hover{border-color:var(--dsw-alias-label-dimmed)}.hp_btn:disabled{opacity:.5;cursor:default}.hp_primary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff)}.hp_danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:0 0}.hp_notice{margin:0;font-size:13px;line-height:20px}.hp_notice[data-kind=error]{color:var(--dsw-alias-state-error-primary)}.hp_notice[data-kind=success]{color:var(--dsw-alias-state-success-primary)}.hp_textarea{width:100%;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.hp_list{margin:0;padding:0;list-style:none;flex-direction:column;gap:8px;display:flex}.hp_row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}.hp_row[data-active=true]{border-color:var(--dsw-alias-state-business-primary)}.hp_rowTop{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.hp_name{font-weight:600;font-size:13px}.hp_meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}.hp_tag{font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);padding:2px 8px;border-radius:10px;color:var(--dsw-alias-label-tertiary)}.hp_badge{font-size:11px;font-weight:600;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);padding:2px 8px;border-radius:10px}.hp_actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.hp_kv{display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap}.hp_code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);padding:2px 6px;border-radius:4px}.hp_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:8px 0}.hp_dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}.hp_dot[data-kind=reused]{background:var(--dsw-alias-state-success-primary)}.hp_dot[data-kind=download]{background:var(--dsw-alias-state-business-primary)}.hp_dot[data-kind=error]{background:var(--dsw-alias-state-error-primary)}.hp_preview{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}.hp_preview li{font-size:12px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px;flex-wrap:wrap}.hp_tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:14px;flex-wrap:wrap}.hp_tab{border:0;border-bottom:2px solid transparent;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;padding:8px 14px;cursor:pointer}.hp_tab:hover{color:var(--dsw-alias-label-primary)}.hp_tab[data-on=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}.hp_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.hp_stat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:10px 12px}.hp_stat .hp_label{font-size:12px;color:var(--dsw-alias-label-tertiary)}.hp_stat .hp_num{font-size:22px;font-weight:700;margin-top:4px}.hp_log{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.7;padding:10px 12px;min-height:160px;max-height:300px;overflow-y:auto;white-space:pre-wrap}.hp_log .ok{color:var(--dsw-alias-state-success-primary)}.hp_log .warn{color:var(--dsw-alias-state-business-primary)}.hp_msg{display:flex;gap:8px;padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l2)}.hp_msg:last-child{border-bottom:0}.hp_msgRole{flex:0 0 auto;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;background:var(--dsw-alias-bg-layer-2);font-size:13px}.hp_msgBody{flex:1 1 auto;min-width:0;flex-direction:column;gap:4px;display:flex}.hp_msgText{font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word}.hp_msgPack{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 10px;font-size:12px;gap:6px;display:flex;flex-wrap:wrap;align-items:center}.hp_msg.err .hp_msgText{color:var(--dsw-alias-state-error-primary)}.hp_aiZone{display:flex;flex-direction:column;gap:10px}.hp_aiTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hp_aiTitle{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;white-space:nowrap}.hp_aiTitle span{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}.hp_aiMark{width:20px;height:20px;display:grid;place-items:center;flex:0 0 20px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);border-radius:6px;font-size:11px;font-weight:800}.hp_aiAv.av-err{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-inverse,#fff)}.hp_aiSpacer{flex:1}.hp_aiTurn{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}.hp_aiChat{display:flex;flex-direction:column;gap:14px;min-height:320px;max-height:52vh;overflow-y:auto;padding:14px 4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px}.hp_aiMsg{display:flex;gap:8px;align-items:flex-start;animation:hpAiIn .22s ease}.hp_aiMsg.user{flex-direction:row-reverse}@keyframes hpAiIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}.hp_aiAv{flex:0 0 28px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:14px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);margin:0 4px}.hp_aiMsg.user .hp_aiAv{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);font-size:11px;font-weight:600}.hp_aiBub{max-width:78%;border-radius:13px;padding:9px 13px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}.hp_aiMsg.assistant .hp_aiBub{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-top-left-radius:4px}.hp_aiMsg.user .hp_aiBub{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);border-top-right-radius:4px}.hp_aiMsg.err .hp_aiBub{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-inverse,#fff);opacity:.92}.hp_aiTyping{display:inline-flex;gap:4px;align-items:center;padding:4px 2px}.hp_aiTyping i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:hpAiDot 1.1s infinite}.hp_aiTyping i:nth-child(2){animation-delay:.18s}.hp_aiTyping i:nth-child(3){animation-delay:.36s}@keyframes hpAiDot{0%,60%,100%{opacity:.35}30%{opacity:1}}.hp_aiPack{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;margin-left:36px;max-width:calc(100% - 36px);animation:hpAiIn .26s ease}.hp_aiPack .head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hp_aiPack .name{font-weight:600;font-size:13px}.hp_aiPack .meta{font-size:12px;color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;flex-wrap:wrap;align-items:center}.hp_aiDiff{display:flex;gap:6px}.hp_aiDiff b{font-weight:600;border-radius:7px;padding:2px 8px;font-size:11.5px}.hp_aiDiff .add{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}.hp_aiDiff .del{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}.hp_aiDiff .chg{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}.hp_aiPlugins{display:flex;flex-direction:column;gap:3px;font-size:12.5px}.hp_aiPlugins .p{display:flex;gap:7px;align-items:center}.hp_aiPlugins .dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}.hp_aiPlugins .pn{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.hp_aiPlugins .pv{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.hp_aiPack .acts{display:flex;gap:8px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px}.hp_aiDock{display:flex;flex-direction:column;gap:8px}.hp_aiInputWrap{display:flex;align-items:flex-end;gap:8px;border:1.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);padding:8px 8px 8px 12px;transition:border-color .15s ease}.hp_aiInputWrap:focus-within{border-color:var(--dsw-alias-state-business-primary)}.hp_aiInputWrap textarea{flex:1;border:0;outline:0;resize:none;background:transparent;font:inherit;font-size:13px;line-height:1.6;max-height:120px;min-height:22px;padding:2px 0;color:var(--dsw-alias-label-primary)}.hp_aiSend{flex:0 0 34px;width:34px;height:34px;border-radius:50%;border:0;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);cursor:pointer;display:grid;place-items:center;transition:transform .12s ease,opacity .15s ease}.hp_aiSend:active{transform:scale(.94)}.hp_aiSend:disabled{opacity:.45;cursor:default}.hp_aiSend svg{width:16px;height:16px}.hp_aiDockNote{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}.hp_aiKeyRow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.hp_settings{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:12px 14px;display:flex;flex-direction:column;gap:8px}.hp_welcome{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 55%);padding:24px 20px;display:flex;flex-direction:column;gap:10px;text-align:center}.hp_welcome .g{font-size:17px;font-weight:700}.hp_welcome .d{font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary);max-width:420px;margin:0 auto}.hp_welcomeRow{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}.hp_check{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:10px 12px;font-size:13px}.hp_check .hp_val{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.hp_chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer}.hp_chip[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff)}.hp_input{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px}.hp_input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.hp_select{flex:0 0 auto;min-width:118px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;cursor:pointer}.hp_topic{flex:0 0 160px}.hp_link{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;height:30px;padding:0 12px;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;gap:5px}.hp_link:hover{border-color:var(--dsw-alias-label-dimmed)}.hp_expand{margin:0;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}.hp_loading{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0;padding:10px 2px;display:flex;align-items:center;gap:8px}.hp_loading .hp_spin{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:hp-rotate .8s linear infinite;display:inline-block}@keyframes hp-rotate{to{transform:rotate(360deg)}}.hp_aiBub code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.hp_aiBub pre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;overflow-x:auto;margin:6px 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5}.hp_aiBub pre code{background:0 0;border:none;padding:0}.hp_aiBub b{font-weight:600}";
		const tagId = "dsh-hotplug-hub/hotplug.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hotplug-hub";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const zh = {
			tab: "热插拔中枢",
			title: "热插拔中枢",
			intro: "空插座：中枢不含任何原生插件，只导入外部热插拔包。插件按路径调用，有就直接复用，缺哪下哪；切换包无损替换，全局记忆不受影响。",
			activeNone: "当前没有激活的包。",
			activeNow: "当前激活",
			restartHint: "挂载 / 卸载在 DSH 服务重启后生效。",
			loadFailed: "读取状态失败：",
			importTitle: "导入热插拔包",
			importPlaceholder: "粘贴 hotpack v1 JSON（参考 docs/hotpack-format.zh.md 与 examples/）",
			importBtn: "导入",
			importFile: "选择 .hotpack.json",
			importing: "导入中…",
			importDone: "已导入：",
			importFailed: "导入失败：",
			packsTitle: "已导入的包",
			packsEmpty: "还没有导入任何热插拔包。把上面的 hotpack JSON 粘贴进来，或选择一个 .hotpack.json 文件。",
			pluginsCount: "个插件",
			activeBadge: "激活中",
			previewBtn: "预览",
			hidePreview: "收起",
			activateBtn: "激活",
			activating: "挂载中…",
			deactivateBtn: "卸载",
			deactivating: "卸载中…",
			removeBtn: "移除",
			activateDone: "已挂载，重启 DSH 后生效：",
			activateFailed: "激活失败：",
			alreadyActive: "该包已经是激活状态。",
			deactivateDone: "已卸载当前包，重启 DSH 后生效。",
			deactivateFailed: "卸载失败：",
			deactivateConfirm: "卸载当前激活包？（只移除 profile 挂载，store 缓存与全局记忆保留）",
			removeDone: "已移除包：",
			removeFailed: "移除失败：",
			removeConfirm: "移除这个包的记录？（不删除已下载的插件缓存）",
			storeTitle: "共享插件仓（hotplug-store）",
			storeEmpty: "hotplug-store 为空。github 源的插件下载后会缓存在这里，供所有包复用。",
			reused: "复用",
			download: "需下载",
			error: "异常",
			wouldReplace: "将无损替换当前激活包：",
			busy: "有操作正在进行，请稍候…",
			navHub: "插件中枢",
			navMarket: "插件市场",
			navAi: "AI 装配间",
			navMemory: "记忆中枢",
			navCheck: "自检更新",
			marketSearch: "搜索包名或标签",
			marketGo: "搜索",
			marketRefresh: "刷新",
			marketFetching: "获取中…",
			marketEmpty: "没有匹配的插件",
			marketInstall: "导入",
			marketInstalled: "已导入",
			marketUnavailable: "不可导入",
			marketTopic: "GitHub 标签",
			marketSource: "来源",
			marketSourceSelect: "抓取通道（可多选）",
			marketSourceGithub: "官方 GitHub",
			marketSourceAll: "全选",
			marketSourceNone: "清空",
			marketSourceDefault: "默认（官方+全部镜像）",
			marketInstallMethod: "安装方法",
			marketRepo: "仓库",
			marketMore: "加载更多",
			marketNoIntro: "（无 README 介绍）",
			marketNoInstall: "README 未找到安装方法",
			marketDetailLoading: "详情加载中…",
			marketFetchError: "获取市场失败：",
			marketRetry: "重试",
			marketOffline: "无法连接 GitHub（官方与镜像均失败），显示内置示例目录",
			marketCached: "缓存于",
			marketTotal: "个结果",
			marketVia: "数据源",
			marketStars: "★",
			marketForks: "⑂",
			marketLicense: "许可",
			marketUpdated: "更新",
			marketNote: "数据来源：GitHub 标签搜索（官方 API + 多镜像站全并发测速取最快），README 对比提取介绍与安装方法",
			aiTitle: "小织女仆 · 装配间",
			aiSubtitle: "人设化对话式装配",
			aiSettings: "连接设置",
			aiConnNote: "连接",
			aiModelNow: "当前模型",
			aiKeyMissing: "本地模拟",
			aiEnterHint: "Enter 发送 · Shift+Enter 换行",
			aiWelcomeTitle: "主人，欢迎来到装配间～",
			aiWelcomeDesc: "描述您需要的工作流，小织会自动挑选真实可用的 npm 插件并织成 hotpack 包。不够满意？直接继续说「换个 xx」「加个功能」，我们边聊边改。",
			aiPlaceholder: "描述您的需求，小织马上开工。",
			aiProviderLabel: "AI 服务商",
			aiPersonaLabel: "装配女仆",
			aiKeyPlaceholder: "API Key（可留空，走服务端对应环境变量）",
			aiBaseUrlPlaceholder: "Base URL（OpenAI 兼容，如 https://api.deepseek.com）",
			aiModelPlaceholder: "模型名（如 deepseek-chat / deepseek-v4-flash / kimi-k3）",
			aiKeyHint: "支持 DeepSeek / OpenCode（hy3、Kimi 等）/ OpenRouter / 硅基流动 / Moonshot / 智谱 GLM / MiniMax 及任意 OpenAI 兼容端点。Key 仅本次会话内存使用，不持久化、不上传日志；建议通过服务端环境变量（DSH_*_API_KEY）配置。安全规则：环境变量里的 Key 只发往内置服务商端点；自定义 Base URL 需在本面板同时填写 Key。",
			aiPersonaHint: "人设只影响语气与情绪价值，不影响装配质量与安全。",
			aiCompose: "开始组装",
			aiComposing: "组装中…",
			aiSend: "发送",
			aiSending: "装配中…",
			aiNewSession: "新会话",
			aiNewSessionConfirm: "开始新会话？当前对话与产物将清空（历史会话仍保存在服务端）。",
			aiWelcome: "主人，欢迎来到装配间～描述您需要的插件能力，小织为您把插件织成包！完成后还可以继续对话调整（「换掉 xx 插件」「加个功能」都行喵～啊不，都行呢）。",
			aiLog: "对话",
			aiResult: "当前产物",
			aiManifest: "pack manifest",
			aiReadme: "README",
			aiCopyManifest: "复制 JSON",
			aiCopyReadme: "复制 README",
			aiExport: "导出到剪贴板",
			aiImport: "一键导入",
			aiDone: "已生成：",
			aiFail: "AI 装配失败：",
			aiBadProduct: "AI 产物校验未通过（缺少插件清单）",
			aiNoGateway: "当前中枢不支持 aiAssemble（需较新版本中枢）",
			aiNoGatewayChat: "当前中枢不支持 aiChat 会话装配（需较新版本中枢）",
			aiDiffTitle: "本轮调整",
			aiDiffAdded: "新增",
			aiDiffRemoved: "移除",
			aiDiffChanged: "调整",
			aiTurn: "第 ",
			aiTurnEnd: " 轮",
			aiSamples: ["我要整理读书笔记：双链引用、全文搜索、自动背卡", "我写技术博客：Markdown 编辑、代码高亮、语法检查", "我做自媒体：热点选题、文案初稿、发布清单"],
			memTitle: "记忆中枢",
			memIntro: "全局记忆包，与 profile 解耦。切换包不影响记忆。",
			memPacks: "全局记忆包",
			memEmpty: "暂无记忆包。记忆目录：",
			memEntries: "条",
			checkTitle: "系统自检",
			checkIntro: "运行时 · profile · 插件 · 冲突",
			checkRecheck: "重新自检",
			checkConflicts: "冲突矩阵",
			checkNoConflicts: "无冲突",
			checkManifest: "Profile 清单",
			checkPatch: "Patch 状态",
			checkNode: "Node.js",
			checkPnpm: "pnpm",
			checkMemory: "记忆中枢",
			checkVersion: "中枢版本",
			checkOk: "正常",
			checkWarn: "警告",
			checkErr: "异常",
			checkPacks: "已导入包",
			checkStore: "Store 缓存",
			checkActivePack: "激活包"
		};
		const en = {};
		const NS = "settings.dshHotplug";
		const looseCodec = () => ({
			mode: "strict",
			typeSymbol: "dsh-hotplug-hub/types#Json",
			schema: { parse: (value) => value }
		});
		const descriptor = (method, parameters) => ({
			id: `dsh-hotplug-hub#dshHotplug/${method}`,
			service: "dshHotplug",
			namespace: "dshHotplug",
			method,
			invocation: { kind: "direct" },
			parameters: parameters.map((name) => ({ name, wire: name, source: "json", codec: looseCodec() })),
			result: looseCodec()
		});
		const REMOTE = {
			package: "dsh-hotplug-hub",
			descriptors: [
				descriptor("status", []),
				descriptor("importPack", ["text"]),
				descriptor("preview", ["packId"]),
				descriptor("activate", ["packId"]),
				descriptor("deactivate", []),
				descriptor("removePack", ["packId"]),
				descriptor("check", []),
				descriptor("marketList", ["params"]),
				descriptor("marketDetail", ["params"]),
				descriptor("aiAssemble", ["params"]),
				descriptor("aiChat", ["params"]),
				descriptor("aiTest", ["params"])
			]
		};
		function unwrap(result) {
			if (result && result.ok !== false) return result.value;
			// R-v5-10（v5 阶段 3）：网关错误序列化 {ok, code, message, exitCode}；
			// message 优先，error 字符串字段废弃（兼容回退）
			const detail = result?.message ?? result?.error?.message ?? String(result?.error ?? "remote failed");
			throw new Error(detail);
		}
		// 市场抓取来源通道：'github'=官方，其余为镜像站域名（与 lib/core/paths.js GITHUB_MIRRORS 一致）
		const MARKET_SOURCE_OPTIONS = ["github", "ghfast.top", "gh-proxy.com", "ghproxy.net", "mirror.ghproxy.com", "ghproxy.cc", "gh-proxy.net"];
		const MARKET_DETAIL_CONCURRENCY = 6;
		// 离线示例目录：仅作展示（无真实插件清单 manifest）。审计修复：此前未标 importable，
		// 渲染层 `installable = p.importable !== false` 把它们当成可导入，doMarketInstall 用
		// plugins:[] 硬拼 manifest → parseHotpack 非空校验必失败（离线「导入」恒报错）。
		// 现显式标 importable:false，按钮正确显示「不可导入」且禁用。
		const CATALOG = [
			{ id: "pack-research", name: "科研插座包", tags: ["科研", "论文", "文献"], desc: "文献检索、综述、论文写作、引用与审稿建议", plugins: 4, accent: "#0e7c6b", importable: false, importError: "离线示例包，需联网搜索真实插件包" },
			{ id: "pack-video", name: "视频制作插座包", tags: ["视频", "剪辑", "字幕"], desc: "脚本、分镜、剪辑清单、字幕与封面生成", plugins: 4, accent: "#b45309", importable: false, importError: "离线示例包，需联网搜索真实插件包" },
			{ id: "pack-social", name: "自媒体插座包", tags: ["自媒体", "选题", "文案"], desc: "热点选题、拆解、文案与发布清单", plugins: 3, accent: "#8b5e3c", importable: false, importError: "离线示例包，需联网搜索真实插件包" },
			{ id: "pack-kaoyan", name: "考研冲刺插座包", tags: ["考研", "学习", "闪卡"], desc: "背诵计划、真题梳理、中日双语文法和闪卡导出", plugins: 3, accent: "#1d5f9e", importable: false, importError: "离线示例包，需联网搜索真实插件包" },
			{ id: "pack-fullstack", name: "全栈开发插座包", tags: ["开发", "全栈", "DevOps"], desc: "脚手架、代码评审、测试和安全检查", plugins: 4, accent: "#5b5488", importable: false, importError: "离线示例包，需联网搜索真实插件包" },
			{ id: "pack-notes", name: "知识管理插座包", tags: ["笔记", "知识库", "整理"], desc: "网页收藏、笔记整理、书摘提取与双链", plugins: 3, accent: "#237a57", importable: false, importError: "离线示例包，需联网搜索真实插件包" }
		];
		// AI 服务商预设（与后端 lib/core/ai.js AI_PROVIDERS 注册表一致的默认值；
		// 后端为权威，此处仅作 UI 快捷填充。label 只写平台名，模型名由模型输入框体现，
		// 避免「服务商下拉 + 模型输入框」出现两处模型名造成困惑）
		const AI_PROVIDER_OPTIONS = [
			{ id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
			{ id: "opencode", label: "OpenCode", baseURL: "https://opencode.ai/zen/go/v1", model: "deepseek-v4-flash" },
			{ id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
			{ id: "siliconflow", label: "硅基流动", baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
			{ id: "moonshot", label: "Moonshot（Kimi）", baseURL: "https://api.moonshot.cn/v1", model: "kimi-k2" },
			{ id: "zhipu", label: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5" },
			{ id: "minimax", label: "MiniMax", baseURL: "https://api.minimaxi.com/v1", model: "MiniMax-M2.7" },
			{ id: "custom", label: "自定义（OpenAI 兼容）", baseURL: "", model: "" },
		];
		const AI_PROVIDER_LABEL = Object.fromEntries(AI_PROVIDER_OPTIONS.map((p) => [p.id, p.label]));
		// 人设 → 头像徽标（文字优先：不依赖 emoji 字体，渲染稳定）；展示名随标题变化
		const AI_PERSONA_BADGE = { maid: "织", butler: "管", neko: "喵", assistant: "助" };
		const AI_PERSONA_NAME = { maid: "小织女仆", butler: "执事管家", neko: "咪咪猫娘", assistant: "标准助手" };
		const AI_PERSONA_DESC = {
			maid: "小织为您挑选真实可用的 npm 插件，织成完整的 hotpack 包～不满意就说「换个 xx」「加个功能」，我们边聊边改。",
			butler: "描述您的工作流需求，我将为您甄选成熟可靠的 npm 插件并装配为完整清单；如不满意，随时吩咐调整。",
			neko: "告诉咪咪你的工作流，咪咪会挑出好用的插件，织成漂漂亮亮的包喵～不满意的主意，直接跟咪咪说喵！",
			assistant: "描述您的工作流需求，系统将挑选真实可用的 npm 插件生成 hotpack 包；装配完成后仍可继续对话调整。",
		};
		// 人设 → 空态欢迎语标题（不写死「主人」；但ler/assistant 称呼不同）
		const AI_PERSONA_GREET = {
			maid: "主人，欢迎来到装配间～小织已经把织布机准备好啦！",
			butler: "先生/女士，欢迎来到装配间。塞德里克随时待命。",
			neko: "主人喵～咪咪来啦，今天想织什么插件包喵？",
			assistant: "欢迎使用 AI 装配间。",
		};
		// 人设 → 空态输入坞占位符（不写死「小织」）
		const AI_PERSONA_PLACEHOLDER = {
			maid: "描述您的需求，小织马上开工。",
			butler: "请描述您的需求，塞德里克立即执行。",
			neko: "告诉咪咪您的需求喵～",
			assistant: "描述您的需求，装配师立即开工。",
		};
		// 人设 → 空态示例芯片（保留核心关键词保证场景命中；语气与内容随人设变化）
		const AI_PERSONA_SAMPLES = {
			maid: ["我要整理读书笔记：双链引用、全文搜索、自动背卡", "我写技术博客：Markdown 编辑、代码高亮、语法检查", "我做自媒体：热点选题、文案初稿、发布清单"],
			butler: ["请规划文献管理工作流：引用整理、全文检索、综述摘要", "构建技术博客流水线：Markdown 编辑、代码高亮、部署检查", "准备自媒体内容排期：热点选题、文案初稿、发布清单"],
			neko: ["咪咪帮我整理读书笔记喵：双链引用、全文搜索、自动背卡", "给我织个写博客的工具包喵：Markdown 编辑、代码高亮、语法检查", "自媒体工作流喵：热点选题、文案初稿、发布清单"],
			assistant: ["整理读书笔记：双链引用、全文搜索、自动背卡", "技术博客流程：Markdown 编辑、代码高亮、语法检查", "自媒体流程：热点选题、文案初稿、发布清单"],
		};
		const AI_PERSONA_OPTIONS = [
			["maid", "小织女仆"], ["butler", "执事管家"], ["neko", "咪咪猫娘"], ["assistant", "标准助手"]
		];
		function HotplugTab(props) {
			const api = props.inject ?? {};
			const t = (key) => (props.locale && props.locale(key)) || zh[key] || en[key] || key;
			const [tab, setTab] = useState("hub");
			const [data, setData] = useState(null);
			const [notice, setNotice] = useState(null);
			const [busy, setBusy] = useState(false);
			const [importText, setImportText] = useState("");
			const [previewId, setPreviewId] = useState(null);
			const [previewData, setPreviewData] = useState(null);
			const [checkData, setCheckData] = useState(null);
			const [marketQuery, setMarketQuery] = useState("");
			const [marketFilter, setMarketFilter] = useState("全部");
			const [marketData, setMarketData] = useState(null);
			const [marketLoading, setMarketLoading] = useState(false);
			const [marketError, setMarketError] = useState(null);
			const [marketSources, setMarketSources] = useState(null); // null = 默认(官方+全部镜像)；否则为选中来源数组 ['github','ghfast.top',...]
			const [marketTopic, setMarketTopic] = useState("dsh-plugin");
			const [marketPage, setMarketPage] = useState(1);
			const [marketOpen, setMarketOpen] = useState(null);
				const [aiInput, setAiInput] = useState("");
				const [aiProvider, setAiProvider] = useState("deepseek");
				const [aiKey, setAiKey] = useState(""); // 仅内存，不持久化（key 安全）
				const [aiBaseURL, setAiBaseURL] = useState(AI_PROVIDER_OPTIONS[0].baseURL);
				const [aiModel, setAiModel] = useState(AI_PROVIDER_OPTIONS[0].model);
				// 人设与会话轮次随 sessionId 一起续接（刷新后徽标/下拉与服务端会话对齐；
				// 均无敏感信息，可入 localStorage——key 绝不落盘）
				const [aiPersona, setAiPersona] = useState(() => {
					try { return window.localStorage.getItem("dshHotplug.aiPersona") || "maid"; } catch { return "maid"; }
				});
				const [aiSessionId, setAiSessionId] = useState(() => {
					// 会话 id 无敏感信息，可入 localStorage（key 绝不落盘）；恢复续接
					try { return window.localStorage.getItem("dshHotplug.aiSessionId") || ""; } catch { return ""; }
				});
				const [aiTurn, setAiTurn] = useState(() => {
					try { return parseInt(window.localStorage.getItem("dshHotplug.aiTurn") || "0", 10) || 0; } catch { return 0; }
				});
			const [aiMessages, setAiMessages] = useState([]); // {role: 'user'|'assistant', text, pack?, diff?, error?}
			const [aiPack, setAiPack] = useState(null); // {name, tags, pack, readme, diff}
			const [aiSettingsOpen, setAiSettingsOpen] = useState(false); // 连接设置折叠面板
			const [aiTesting, setAiTesting] = useState(false); // 「测试连接」进行中
			const [aiTyping, setAiTyping] = useState(false); // 打字指示器
			const [aiRunning, setAiRunning] = useState(false);
			const fileRef = useRef(null);
			const say = (kind, text) => setNotice({ kind, text });
			const load = async () => {
				try {
					const status = unwrap(await api.status());
					setData(status);
				} catch (error) {
					say("error", t("loadFailed") + String(error.message ?? error));
				}
			};
			useEffect(() => { load(); }, []);
			const run = async (label, task) => {
				if (busy) { say("error", t("busy")); return; }
				setBusy(true);
				try {
					const result = unwrap(await task());
					if (result && result.ok === false) {
						say("error", t(label + "Failed") + String(result.message ?? result.error ?? ""));
						return result;
					}
					await load();
					return result;
				} catch (error) {
					say("error", t(label + "Failed") + String(error.message ?? error));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const doImport = () => run("import", () => api.importPack(importText)).then((result) => {
				if (result && result.ok) {
					say("success", t("importDone") + result.pack.name + "（" + result.pack.plugins + t("pluginsCount") + "）");
					setImportText("");
				}
			});
			const onFile = (event) => {
				const file = event.target.files && event.target.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => {
					setImportText(String(reader.result ?? ""));
					run("import", () => api.importPack(String(reader.result ?? ""))).then((result) => {
						if (result && result.ok) {
							say("success", t("importDone") + result.pack.name + "（" + result.pack.plugins + t("pluginsCount") + "）");
							setImportText("");
						}
					});
				};
				reader.readAsText(file);
				event.target.value = "";
			};
			const togglePreview = async (packId) => {
				if (previewId === packId) { setPreviewId(null); setPreviewData(null); return; }
				try {
					const result = unwrap(await api.preview(packId));
					if (result && result.ok === false) { say("error", result.message ?? result.error); return; }
					setPreviewId(packId);
					setPreviewData(result);
				} catch (error) {
					say("error", String(error.message ?? error));
				}
			};
			const doActivate = (packId) => run("activate", () => api.activate(packId)).then((result) => {
				if (!result) return;
				if (result.already) { say("success", t("alreadyActive")); return; }
				if (result.ok) say("success", t("activateDone") + packId);
			});
			const doDeactivate = () => {
				if (!window.confirm(t("deactivateConfirm"))) return;
				run("deactivate", () => api.deactivate()).then((result) => {
					if (result && result.ok) say("success", t("deactivateDone"));
				});
			};
			const doRemove = (packId) => {
				if (!window.confirm(t("removeConfirm"))) return;
				run("remove", () => api.removePack(packId)).then((result) => {
					if (result && result.ok) say("success", t("removeDone") + packId);
				});
			};
			const doCheck = async () => {
				try {
					const result = unwrap(await api.check());
					setCheckData(result);
				} catch (error) {
					say("error", String(error.message ?? error));
				}
			};
			const loadMarket = async (params) => {
				setMarketLoading(true);
				setMarketError(null);
				try {
					const result = unwrap(await api.marketList(params));
					if (result && result.ok === false) {
						setMarketError(String(result.message ?? result.error ?? "?"));
					} else if (result && Array.isArray(result.entries)) {
						const listEntries = result.entries;
						// hasMore 是服务端权威契约（本页满页 && page < 分页上限）——
						// 审计修复：此前用 entries.length < total 判断，GitHub total_count
						// 动辄上千而 page 被服务端 clamp 到上限，按钮永不消失、末页重复请求。
						const hasMore = result.hasMore === true;
						setMarketData((prev) => {
							if (!prev || (params.page ?? 1) === 1) {
								return { entries: listEntries, total: result.total ?? listEntries.length, sources: result.sources ?? params.sources ?? null, cachedAt: result.cachedAt ?? null, cached: result.cached === true, hasMore };
							}
							const seen = new Set(prev.entries.map((e) => e.id));
							return { ...prev, entries: [...prev.entries, ...listEntries.filter((e) => !seen.has(e.id))], total: result.total ?? prev.total, hasMore };
						});
						// 列表已渲染；逐条并发抓详情，谁先返回谁先填进卡片，不等待其余。
						hydrateMarketDetails(listEntries, result.sources ?? params.sources ?? null, params.refresh === true);
					} else {
						setMarketError("marketList 返回异常");
					}
				} catch (error) {
					setMarketError(String(error.message ?? error));
				} finally {
					setMarketLoading(false);
				}
			};
			// 并发抓取每条详情（受限并发），返回即覆盖对应卡片；不阻塞列表展示。
			// 审计修复：透传 refresh——此前刷新按钮只刷新列表元数据，详情（README/安装/manifest/
			// importable）永远命中 MARKET_DETAIL_CACHE_FILE 缓存，直至 400 条 FIFO 淘汰。
			const hydrateMarketDetails = (entries, sources, refresh) => {
				const pending = entries.filter((e) => e && e.detailPending !== false);
				if (pending.length === 0) return;
				let index = 0;
				const worker = async () => {
					while (index < pending.length) {
						const e = pending[index++];
						try {
							const result = unwrap(await api.marketDetail({ repo: e.repo, ref: e.ref, sources, meta: e, refresh }));
							const entry = result && result.entry;
							if (!entry) continue;
							setMarketData((prev) => {
								if (!prev) return prev;
								return { ...prev, entries: prev.entries.map((x) => (x.id === e.id ? { ...x, ...entry, detailPending: false } : x)) };
							});
						} catch {
							// 审计修复：catch 原为空转——注释声称"标记不可导入"却未实现，导致
							// detailPending 永远为 true、卡片永久「加载中…」。现显式标记失败态。
							setMarketData((prev) => {
								if (!prev) return prev;
								return {
									...prev,
									entries: prev.entries.map((x) => (x.id === e.id
										? { ...x, detailPending: false, importable: false, importError: "详情加载失败，可稍后重试" }
										: x)),
								};
							});
						}
					}
				};
				Array.from({ length: Math.min(MARKET_DETAIL_CONCURRENCY, pending.length) }, () => worker());
			};
			const marketParams = (page, refresh) => ({ topic: marketTopic, q: marketQuery, sources: marketSources, page, refresh });
			const doMarketSearch = () => { setMarketPage(1); loadMarket(marketParams(1, false)); };
			const doMarketRefresh = () => { setMarketPage(1); loadMarket(marketParams(1, true)); };
			const doMarketMore = () => { const next = marketPage + 1; setMarketPage(next); loadMarket(marketParams(next, false)); };
			const doMarketInstall = (pack) => {
				// 审计修复：无真实 manifest 的条目（离线 CATALOG 示例 / 详情抓取失败的仓库）
				// 此前用 plugins:[] 硬拼 manifest → parseHotpack 非空校验必失败。现显式拒绝，
				// 不再发起注定失败的 import（渲染层已用 importable:false 禁用按钮，此为双保险）。
				if (!pack.manifest) {
					say("error", (pack.importError || t("marketUnavailable")));
					return;
				}
				run("import", () => api.importPack(JSON.stringify(pack.manifest))).then((result) => {
					if (result && result.ok) {
						say("success", t("importDone") + pack.name);
						setTab("hub");
					}
				});
			};
			// AI 装配间（v5 阶段 5 增强）：人设化对话式装配（网关 aiChat）。
			// 首轮=需求→装配；后续轮=对话式增量修改（服务端 diff 新增/移除/调整）。
			// 产物已由服务端权威 parseHotpack 校验，此处仅兜底断言。
			// key 安全：aiKey 仅内存 state（不持久化）；留空时服务端读 DSH_*_API_KEY。
			// 审计修复：provider 必须随请求上送——此前只送 baseURL/model（且仅在与预设
			// 不同时），选 OpenCode 等预设实际仍打到 DeepSeek 端点（底栏显示与真实调用不符）。
			const doAiSend = () => {
				if (!aiInput.trim() || aiRunning) return;
				const text = aiInput.trim();
				setAiInput("");
				setAiMessages((prev) => [...prev, { role: "user", text }]);
				setAiTyping(true);
				setAiRunning(true);
				const task = () => {
					const preset = AI_PROVIDER_OPTIONS.find((p) => p.id === aiProvider);
					const params = {
						input: text,
						persona: aiPersona,
						sessionId: aiSessionId || undefined,
						apiKey: aiKey.trim() || undefined,
						// custom 无注册表条目（服务端按 baseURL 解析），其余预设显式点名
						provider: aiProvider !== "custom" ? aiProvider : undefined
					};
					if (aiBaseURL.trim() !== "" && aiBaseURL.trim() !== (preset && preset.baseURL)) params.baseURL = aiBaseURL.trim();
					if (aiModel.trim() !== "" && aiModel.trim() !== (preset && preset.model)) params.model = aiModel.trim();
					return api.aiChat(params).then(unwrap).then((r) => {
						if (!r || r.ok === false) throw new Error(String((r && (r.message || r.error)) || t("aiFail")));
						return r;
					});
				};
				task()
					.then((r) => {
						const d = (r && r.data) || r;
						const sess = (d && d.session) || {};
						if (sess.id) {
							setAiSessionId(sess.id);
							try { window.localStorage.setItem("dshHotplug.aiSessionId", sess.id); } catch { /* 尽力而为 */ }
						}
						// 服务端会话为权威：人设（显式切换已生效）与轮次对齐，并随会话 id 续接
						if (sess.persona) {
							setAiPersona(sess.persona);
							try { window.localStorage.setItem("dshHotplug.aiPersona", sess.persona); } catch { /* 尽力而为 */ }
						}
						if (typeof sess.turn === "number") {
							setAiTurn(sess.turn);
							try { window.localStorage.setItem("dshHotplug.aiTurn", String(sess.turn)); } catch { /* 尽力而为 */ }
						}
						if (d && d.warning) say("error", d.warning);
						const reply = d && d.reply ? String(d.reply) : "";
						const pack = d && d.pack ? d.pack : null;
						const diff = (d && d.diff) || null;
						const readme = (d && d.readme) || "";
						if (reply !== "" || pack) {
							// 产物卡数据随消息保存（含 readme）：多轮后每张卡的按钮作用于该卡自身的产物
							setAiMessages((prev) => [...prev, { role: "assistant", text: reply !== "" ? reply : (t("aiDone") + pack.name), persona: sess.persona || aiPersona, pack, diff, readme, error: false }]);
						}
						if (pack) {
							setAiPack({ name: pack.name, tags: pack.tags || [], pack, readme, diff });
						}
					})
					.catch((e) => {
						// 老中枢无 aiChat 面：注入包装恒为函数，真实失败点在 face 调用——
						// 把底层 TypeError 翻译成可读提示而非裸 "face.aiChat is not a function"
						const raw = String((e && e.message) || e);
						const msg = /aiChat[\s\S]*is not a function/.test(raw) ? t("aiNoGatewayChat") : raw;
						setAiMessages((prev) => [...prev, { role: "assistant", text: t("aiFail") + msg, persona: aiPersona, pack: null, diff: null, error: true }]);
					})
					.finally(() => { setAiTyping(false); setAiRunning(false); });
			};
			// 连接测试：经网关 aiTest 走服务端（与装配同一解析链路）——浏览器直连
			// 既过不了厂商 CORS，也测不到服务端 env key 配置；服务端 env key 只发
			// 注册表端点，自定义端点必须同时填 Key（网关侧安全规则）。
			const doAiTest = () => {
				if (aiTesting) return;
				const preset = AI_PROVIDER_OPTIONS.find((p) => p.id === aiProvider);
				const params = { provider: aiProvider !== "custom" ? aiProvider : undefined, apiKey: aiKey.trim() || undefined };
				if (aiBaseURL.trim() !== "" && aiBaseURL.trim() !== (preset && preset.baseURL)) params.baseURL = aiBaseURL.trim();
				if (aiModel.trim() !== "" && aiModel.trim() !== (preset && preset.model)) params.model = aiModel.trim();
				setAiTesting(true);
				// 客户端看门狗（20s > 服务端 15s 超时 + 余量）：RPC 桥异常挂起时按钮也不永久禁用
				let settled = false;
				const finish = (report) => () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					report();
					setAiTesting(false);
				};
				const timer = setTimeout(() => finish(() => say("error", "连接失败：超时（20s）"))(), 20000);
				Promise.resolve()
					.then(() => api.aiTest(params))
					.then(unwrap)
					.then((r) => {
						const d = (r && r.data) || r;
						const model = (d && d.model) || aiModel.trim() || (preset && preset.model) || "";
						const latency = d && typeof d.latencyMs === "number" ? "（" + d.latencyMs + "ms）" : "";
						finish(() => say("success", "✓ 连接成功：" + model + latency))();
					})
					.catch((e) => {
						const raw = String((e && e.message) || e);
						const msg = /aiTest[\s\S]*(is not a function|unavailable)/.test(raw) ? "当前中枢不支持连接测试（需较新版本中枢）" : raw;
						finish(() => say("error", "连接失败：" + msg))();
					});
			};
			const doAiNewSession = () => {
				if (aiMessages.length === 0 && !aiSessionId) return;
				if (!window.confirm(t("aiNewSessionConfirm"))) return;
				setAiSessionId("");
				setAiMessages([]);
				setAiPack(null);
				setAiInput("");
				setAiTurn(0);
				try {
					window.localStorage.removeItem("dshHotplug.aiSessionId");
					window.localStorage.removeItem("dshHotplug.aiTurn");
				} catch { /* 尽力而为 */ }
			};
			// 一键导入：作用于"该产物卡"的清单（多轮会话中每张卡导入自己的版本，
			// 而非恒定导入最新一轮——此前旧卡按钮会导入新包，与用户所见不符）
			const doAiImport = (pack) => {
				const target = pack || (aiPack && aiPack.pack);
				if (!target) return;
				run("import", () => api.importPack(JSON.stringify(target))).then((result) => {
					if (result && result.ok) {
						say("success", t("importDone") + (target.name || target.id));
						setTab("hub");
					} else {
						// 修复：导入失败显式反馈（此前静默）
						say("error", t("importFailed") + String((result && (result.message || result.error)) || ""));
					}
				});
			};
			const renderAiDiff = (diff) => {
				if (!diff) return null;
				const rows = [];
				(diff.added || []).forEach((p) => rows.push({ kind: "added", text: (p.name || p.id) + "@" + (p.version || "?") }));
				(diff.removed || []).forEach((p) => rows.push({ kind: "removed", text: (p.name || p.id) + "@" + (p.version || "?") }));
				(diff.changed || []).forEach((c) => {
					// 纯 config 调整（版本未变）显示"配置调整"，避免渲染成无信息的 "1.0.0 → 1.0.0"
					const sameVersion = (c.from && c.to && c.from.version === c.to.version);
					const text = c.configChanged && sameVersion
						? (c.id || "?") + ": 配置调整"
						: (c.id || "?") + ": " + ((c.from && c.from.version) || "?") + " → " + ((c.to && c.to.version) || "?");
					rows.push({ kind: "changed", text });
				});
				if (rows.length === 0) return null;
				const color = { added: "var(--dsw-alias-state-success-primary)", removed: "var(--dsw-alias-state-error-primary)", changed: "var(--dsw-alias-state-business-primary)" };
				const label = { added: "+ " + t("aiDiffAdded"), removed: "- " + t("aiDiffRemoved"), changed: "~ " + t("aiDiffChanged") };
				return h("ul", { className: "hp_list", style: { marginTop: 4 } }, rows.map((r, i) =>
					h("li", { key: i, className: "hp_row", style: { padding: "6px 10px", flexDirection: "row", alignItems: "center", gap: 8 } },
						h("span", { className: "hp_tag", style: { color: color[r.kind] } }, label[r.kind]),
						h("span", { className: "hp_info", style: { margin: 0 } }, r.text)
					)
				));
			};
			const activePack = data && data.packs ? data.packs.find((pack) => pack.active) : null;
			const tabs = [
				{ id: "hub", label: t("navHub") },
				{ id: "market", label: t("navMarket") },
				{ id: "ai", label: t("navAi") },
				{ id: "memory", label: t("navMemory") },
				{ id: "check", label: t("navCheck") }
			];
			const renderHub = () => h("div", null,
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" },
						h("h3", null, t("title")),
						data ? h("span", null, "v" + data.version + " · profile " + data.profile.name) : null
					),
					h("p", { className: "hp_info" }, t("intro")),
					h("div", { className: "hp_kv" },
						h("b", null, t("activeNow") + ":"),
						activePack
							? h("span", { className: "hp_code" }, activePack.name + " " + (activePack.version ?? ""))
							: h("span", null, t("activeNone"))
					),
					h("p", { className: "hp_info" }, t("restartHint"))
				),
				notice ? h("p", { className: "hp_notice", "data-kind": notice.kind }, notice.text) : null,
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("importTitle"))),
					h("textarea", {
						className: "hp_textarea", placeholder: t("importPlaceholder"), value: importText,
						onChange: (event) => setImportText(event.target.value), spellCheck: false
					}),
					h("div", { className: "hp_bar" },
						h("button", { className: "hp_btn hp_primary", disabled: busy || importText.trim() === "", onClick: doImport }, busy ? t("importing") : t("importBtn")),
						h("button", { className: "hp_btn", disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, t("importFile")),
						h("input", { ref: fileRef, type: "file", accept: ".json,.hotpack.json,application/json", style: { display: "none" }, onChange: onFile })
					)
				),
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" },
						h("h3", null, t("packsTitle")),
						data && data.packs ? h("span", null, String(data.packs.length)) : null
					),
					!data || data.packs.length === 0
						? h("p", { className: "hp_empty" }, t("packsEmpty"))
						: h("ul", { className: "hp_list" }, data.packs.map((pack) =>
							h("li", { key: pack.id, className: "hp_row", "data-active": pack.active },
								h("div", { className: "hp_rowTop" },
									h("span", { className: "hp_name" }, pack.name),
									h("div", { className: "hp_meta" },
										h("span", { className: "hp_tag" }, pack.version ?? ""),
										h("span", { className: "hp_tag" }, pack.plugins.length + t("pluginsCount")),
										(pack.tags ?? []).map((tag) => h("span", { key: tag, className: "hp_tag" }, tag)),
										pack.active ? h("span", { className: "hp_badge" }, t("activeBadge")) : null
									),
									h("div", { className: "hp_actions" },
										h("button", { className: "hp_btn", disabled: busy, onClick: () => togglePreview(pack.id) }, previewId === pack.id ? t("hidePreview") : t("previewBtn")),
										pack.active
											? h("button", { className: "hp_btn", disabled: busy, onClick: doDeactivate }, busy ? t("deactivating") : t("deactivateBtn"))
											: h("button", { className: "hp_btn hp_primary", disabled: busy, onClick: () => doActivate(pack.id) }, busy ? t("activating") : t("activateBtn")),
										pack.active ? null : h("button", { className: "hp_btn hp_danger", disabled: busy, onClick: () => doRemove(pack.id) }, t("removeBtn"))
									)
								),
								pack.description ? h("div", { className: "hp_meta" }, pack.description) : null,
								previewId === pack.id && previewData
									? h("ul", { className: "hp_preview" },
										previewData.wouldReplace ? h("li", null, h("span", { className: "hp_dot", "data-kind": "download" }), t("wouldReplace") + previewData.wouldReplace) : null,
										previewData.refs.map((ref) =>
											h("li", { key: ref.id },
												h("span", { className: "hp_dot", "data-kind": ref.action === "reused" ? "reused" : ref.action === "download" ? "download" : "error" }),
												h("b", null, ref.name),
												h("span", null, ref.version ? "@" + ref.version : ""),
												h("span", null, "· " + ref.detail)
											)
										)
									) : null
							)
						))
				),
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("storeTitle"))),
					h("div", { className: "hp_kv" }, h("span", { className: "hp_code" }, data ? data.store.dir : "…")),
					!data || data.store.entries.length === 0
						? h("p", { className: "hp_info" }, t("storeEmpty"))
						: h("div", { className: "hp_meta" }, data.store.entries.map((entry) => h("span", { key: entry, className: "hp_tag" }, entry)))
				)
			);
			const sourceEntries = marketData ? marketData.entries : [];
			const marketCats = ["全部", ...new Set(sourceEntries.length ? sourceEntries.flatMap((p) => p.topics ?? p.tags ?? []) : CATALOG.flatMap((p) => p.tags))];
			const marketQ = marketQuery.trim().toLowerCase();
			// 审计修复：空结果是真实搜索结果（显示「没有匹配的插件」），不再回退内置示例
			// 目录——CATALOG 只在「尚无数据」（初始态/网络失败）时作为离线展示。
			const marketPool = marketData ? sourceEntries : CATALOG;
			const shown = marketPool.filter((p) => {
				const tags = p.topics ?? p.tags ?? [];
				const hay = (p.name || "").toLowerCase() + " " + tags.join(" ").toLowerCase() + " " + String(p.intro || p.description || p.desc || "").toLowerCase();
				return (marketFilter === "全部" || tags.includes(marketFilter)) && (!marketQ || hay.includes(marketQ));
			});
			const importedIds = data && data.packs ? new Set(data.packs.map((p) => p.id)) : new Set();
			const renderMarketCard = (p) => {
				const tags = p.topics ?? p.tags ?? [];
				const desc = p.intro || p.description || p.desc || "";
				const pending = p.detailPending === true;
				const installable = !pending && p.importable !== false;
				return h("div", { key: p.id, className: "hp_card" },
					h("div", { className: "hp_rowTop" },
						h("div", null,
							h("div", { className: "hp_name" }, p.name),
							h("div", { className: "hp_meta" },
								p.author ? h("span", { key: "au", className: "hp_tag" }, p.author) : null,
								typeof p.stars === "number" ? h("span", { key: "st", className: "hp_tag" }, t("marketStars") + " " + p.stars) : null,
								p.version ? h("span", { key: "ve", className: "hp_tag" }, "v" + p.version) : null,
								p.license ? h("span", { key: "li", className: "hp_tag" }, t("marketLicense") + " " + p.license) : null,
								p.npmName ? h("span", { key: "np", className: "hp_tag" }, p.npmName) : null
							)
						),
						importedIds.has(p.id) ? h("span", { className: "hp_tag" }, t("marketInstalled")) : null
					),
					tags.length ? h("div", { className: "hp_meta" }, tags.map((tag) => h("span", { key: tag, className: "hp_tag" }, tag))) : null,
					h("p", { className: "hp_info" }, pending ? t("marketDetailLoading") : (desc || t("marketNoIntro"))),
					h("div", { className: "hp_bar" },
						h("button", { className: "hp_btn", disabled: pending || !p.install, onClick: () => setMarketOpen(marketOpen === p.id ? null : p.id) }, t("marketInstallMethod")),
						p.repoUrl ? h("a", { className: "hp_link", href: p.repoUrl, target: "_blank", rel: "noreferrer" }, t("marketRepo")) : null,
						typeof p.plugins === "number" ? h("span", { className: "hp_stat" }, p.plugins + t("pluginsCount")) : null,
						p.hasPack ? h("span", { className: "hp_tag" }, "hotpack") : null,
						p.updatedAt ? h("span", { className: "hp_stat" }, t("marketUpdated") + " " + String(p.updatedAt).slice(0, 10)) : null
					),
					marketOpen === p.id ? h("pre", { className: "hp_expand" }, p.install || t("marketNoInstall")) : null,
					importedIds.has(p.id) ? null : h("div", { className: "hp_bar" },
						h("button", { className: "hp_btn hp_primary", disabled: busy || !installable, title: p.importError ?? "", onClick: () => doMarketInstall(p) },
							pending ? t("marketDetailLoading") : (installable ? t("marketInstall") : t("marketUnavailable")))
					)
				);
			};
			const renderMarket = () => h("div", null,
				notice ? h("p", { className: "hp_notice", "data-kind": notice.kind }, notice.text) : null,
				h("div", { className: "hp_card" },
					h("div", { className: "hp_bar" },
						h("input", { className: "hp_input", placeholder: t("marketSearch"), value: marketQuery, onChange: (e) => setMarketQuery(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doMarketSearch(); } }),
						h("input", { className: "hp_input hp_topic", placeholder: t("marketTopic"), value: marketTopic, onChange: (e) => setMarketTopic(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doMarketSearch(); }, title: "GitHub topic，如 dsh-plugin" }),
						h("button", { className: "hp_btn hp_primary", disabled: marketLoading, onClick: doMarketSearch }, marketLoading ? t("marketFetching") : t("marketGo")),
						h("button", { className: "hp_btn", disabled: marketLoading, onClick: doMarketRefresh }, t("marketRefresh")),
						h("button", { className: "hp_btn", disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, t("importFile")),
						h("input", { ref: fileRef, type: "file", accept: ".json,.hotpack.json,application/json", style: { display: "none" }, onChange: onFile })
					),
					h("div", { className: "hp_bar" },
						h("span", { className: "hp_stat" }, t("marketSourceSelect")),
						MARKET_SOURCE_OPTIONS.map((s) => {
							const on = !marketSources || marketSources.includes(s);
							return h("button", { key: s, className: "hp_chip", "data-on": on, title: s === "github" ? "api.github.com" : s, onClick: () => {
								setMarketSources((prev) => {
									const cur = prev ? [...prev] : [...MARKET_SOURCE_OPTIONS];
									const has = cur.includes(s);
									const next = has ? cur.filter((x) => x !== s) : [...cur, s];
									return next.length === MARKET_SOURCE_OPTIONS.length || next.length === 0 ? null : next;
								});
								setMarketPage(1);
							} }, s === "github" ? t("marketSourceGithub") : s);
						}),
						h("button", { className: "hp_chip", onClick: () => { setMarketSources(null); setMarketPage(1); } }, t("marketSourceDefault"))
					),
					h("div", { className: "hp_bar" },
						marketCats.map((cat) => h("button", { key: cat, className: "hp_chip", "data-on": cat === marketFilter, onClick: () => setMarketFilter(cat) }, cat)),
						marketData ? h("span", { className: "hp_stat" }, marketData.total + t("marketTotal") + (marketData.fetchedVia ? " · " + t("marketVia") + " " + marketData.fetchedVia : "") + (marketData.cached && marketData.cachedAt ? " · " + t("marketCached") + " " + String(marketData.cachedAt).slice(0, 10) : "")) : null
					)
				),
				marketLoading && !marketData ? h("div", { className: "hp_card" }, h("p", { className: "hp_loading" }, h("span", { className: "hp_spin" }), t("marketFetching")), h("p", { className: "hp_info" }, t("marketNote"))) : null,
				marketError && !marketData ? h("div", { className: "hp_card" },
					h("p", { className: "hp_notice", "data-kind": "error" }, t("marketFetchError") + marketError),
					h("div", { className: "hp_bar" },
						h("button", { className: "hp_btn", onClick: doMarketSearch }, t("marketRetry")),
						h("span", { className: "hp_stat" }, t("marketOffline"))
					)
				) : null,
				h("div", { className: "hp_grid" },
					shown.length ? shown.map(renderMarketCard) : h("p", { className: "hp_empty" }, t("marketEmpty"))
				),
				// 审计修复：hasMore 为服务端权威契约（hasMore:true 才显示；旧网关无该字段
				// 时按钮不出现——保守方向，杜绝「末页重复请求永不消失」）。
				marketData && marketData.hasMore === true ? h("div", { className: "hp_bar", style: { justifyContent: "center" } },
					h("button", { className: "hp_btn", disabled: marketLoading, onClick: doMarketMore }, marketLoading ? t("marketFetching") : t("marketMore"))
				) : null,
				marketData ? h("p", { className: "hp_info" }, t("marketNote")) : null
			);
			const renderAiMsg = (m, index) => {
				if (m.role === "user") {
					return h("div", { key: index, className: "hp_aiMsg user" },
						h("div", { className: "hp_aiAv" }, "您"),
						h("div", { className: "hp_aiBub" }, m.text)
					);
				}
				return h("div", { key: index, className: "hp_aiMsg" + (m.error ? " err" : ""), style: m.pack ? { marginBottom: 0 } : null, role: m.error ? "alert" : null },
					h("div", { className: "hp_aiAv" + (m.error ? " av-err" : "") }, m.error ? "!" : (AI_PERSONA_BADGE[m.persona || aiPersona] || "助")),
					h("div", { className: "hp_aiBub" }, fmtText(m.text)),
					m.pack ? renderPackCard(m.pack, m.diff, m.readme) : null
				);
			};
			// 助理文本轻渲染（先转义语义后渲染：代码围栏 > 行内代码 > 加粗；链接剥为纯文本）
			const fmtText = (text) => {
				const nodes = [];
				const blocks = [];
				let s = String(text || "").replace(/```([\s\S]*?)```/g, (m, c) => {
					blocks.push(c);
					return "\u0000B" + (blocks.length - 1) + "\u0000";
				});
				s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
				s = s.replace(/^\|[\s:|-]+\|\s*$/gm, ""); // 表格分隔行降级丢弃
				s = s.replace(/^\|(.+)\|\s*$/gm, (m, inner) => inner.split("|").map((x) => x.trim()).filter(Boolean).join(" · "));
				for (const seg of s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
					if (!seg) continue;
					const bm = seg.match(/^\u0000B(\d+)\u0000$/);
					if (bm) { nodes.push(h("pre", { key: nodes.length }, h("code", null, blocks[+bm[1]]))); continue; }
					if (seg.startsWith("**")) nodes.push(h("b", { key: nodes.length }, seg.slice(2, -2)));
					else if (seg.startsWith("`")) nodes.push(h("code", { key: nodes.length }, seg.slice(1, -1)));
					else nodes.push(seg);
				}
				return nodes;
			};
			const renderPackCard = (pack, diff, readme) => {
				const d = diff || { added: [], removed: [], changed: [] };
				const diffEl = (d.added.length + d.removed.length + d.changed.length) > 0
					? h("div", { className: "hp_aiDiff" },
						d.added.length ? h("b", { className: "add" }, "+ 新增 " + d.added.length) : null,
						d.removed.length ? h("b", { className: "del" }, "- 移除 " + d.removed.length) : null,
						d.changed.length ? h("b", { className: "chg" }, "~ 调整 " + d.changed.length) : null
					) : null;
				return h("div", { className: "hp_aiPack" },
					h("div", { className: "head" },
						h("span", { className: "name" }, "📦 " + pack.name),
						h("span", { className: "meta" }, (pack.plugins || []).length + t("pluginsCount"), diffEl)
					),
					h("div", { className: "hp_aiPlugins" }, (pack.plugins || []).map((p) =>
						h("div", { key: p.id ?? p.name, className: "p" },
							h("span", { className: "dot" }),
							h("span", { className: "pn" }, p.name + "@" + p.version),
							h("span", { className: "pv" }, p.id)
						)
					)),
					h("div", { className: "acts" },
						h("button", { className: "hp_btn hp_primary", disabled: busy, onClick: () => doAiImport(pack) }, t("aiImport")),
						h("button", { className: "hp_btn", onClick: () => { try { navigator.clipboard.writeText(JSON.stringify(pack, null, 2)); } catch { /* 尽力而为 */ } } }, t("aiCopyManifest")),
						h("button", { className: "hp_btn", onClick: () => { try { navigator.clipboard.writeText(readme || ""); } catch { /* 尽力而为 */ } } }, t("aiCopyReadme"))
					)
				);
			};
			const renderAi = () => h("div", { className: "hp_aiZone" },
				notice ? h("p", { className: "hp_notice", "data-kind": notice.kind }, notice.text) : null,
				h("div", { className: "hp_aiTop" },
					h("div", { className: "hp_aiTitle" }, h("span", { className: "hp_aiMark" }, "织"), h("span", null, AI_PERSONA_NAME[aiPersona] || "小织女仆"), h("span", null, "· 装配间")),
					h("div", { className: "hp_aiSpacer" }),
					h("select", { className: "hp_input", style: { width: "auto" }, value: aiPersona, title: "切换装配女仆", onChange: (e) => {
						setAiPersona(e.target.value);
						try { window.localStorage.setItem("dshHotplug.aiPersona", e.target.value); } catch { /* 尽力而为 */ }
					} },
						AI_PERSONA_OPTIONS.map(([id, label]) => h("option", { key: id, value: id }, label))
					),
					h("button", { className: "hp_btn", onClick: () => setAiSettingsOpen(!aiSettingsOpen) }, "⚙ 模型"),
					h("span", { className: "hp_aiTurn" }, aiSessionId ? t("aiTurn") + String(Math.max(aiTurn || 1, 1)) + t("aiTurnEnd") : ""),
					h("button", { className: "hp_btn", disabled: busy || (aiMessages.length === 0 && !aiSessionId), onClick: doAiNewSession }, t("aiNewSession"))
				),
				aiSettingsOpen ? h("div", { className: "hp_settings" },
					h("div", { className: "hp_aiKeyRow" },
						h("label", null, t("aiProviderLabel")),
						h("select", { className: "hp_input", style: { flex: "0 1 200px" }, value: aiProvider, onChange: (e) => {
							const preset = AI_PROVIDER_OPTIONS.find((p) => p.id === e.target.value);
							setAiProvider(e.target.value);
							if (preset) { setAiBaseURL(preset.baseURL); setAiModel(preset.model); }
						} },
							AI_PROVIDER_OPTIONS.map((p) => h("option", { key: p.id, value: p.id }, p.label))
						),
						h("input", { className: "hp_input", style: { flex: 1 }, placeholder: t("aiModelPlaceholder"), value: aiModel, onChange: (e) => setAiModel(e.target.value), spellCheck: false }),
						h("button", { className: "hp_btn", disabled: aiTesting, onClick: doAiTest }, aiTesting ? "测试中…" : "测试连接")
					),
					h("div", { className: "hp_aiKeyRow" },
						h("label", null, "Key"),
						h("input", { type: "password", className: "hp_input", style: { flex: 1 }, placeholder: t("aiKeyPlaceholder"), value: aiKey, onChange: (e) => setAiKey(e.target.value), autoComplete: "off", spellCheck: false }),
						h("input", { className: "hp_input", style: { flex: 1 }, placeholder: t("aiBaseUrlPlaceholder"), value: aiBaseURL, onChange: (e) => setAiBaseURL(e.target.value), spellCheck: false })
					),
					h("p", { className: "hp_info" }, "预设端点已实测校正：OpenCode = OpenCode Go（需 Go credits Key）；自定义需自填 https:// Base URL。"),
					h("p", { className: "hp_info" }, t("aiKeyHint")),
					h("p", { className: "hp_info" }, t("aiPersonaHint"))
				) : null,
				h("div", { className: "hp_aiChat", "aria-live": "polite" },
					aiMessages.length === 0
						? h("div", { className: "hp_welcome" },
							h("div", { className: "g" }, AI_PERSONA_GREET[aiPersona] || t("aiWelcomeTitle")),
							h("div", { className: "d" }, AI_PERSONA_DESC[aiPersona] || t("aiWelcomeDesc")),
							h("div", { className: "hp_welcomeRow" }, (AI_PERSONA_SAMPLES[aiPersona] || t("aiSamples")).map((sample) =>
								h("button", { key: sample, className: "hp_chip", onClick: () => setAiInput(sample) }, sample)
							))
						)
						: h("div", null, aiMessages.map(renderAiMsg), aiTyping ? h("div", { key: "typing", className: "hp_aiMsg" },
							h("div", { className: "hp_aiAv" }, AI_PERSONA_BADGE[aiPersona] || "助"),
							h("div", { className: "hp_aiBub" }, h("span", { className: "hp_aiTyping" }, h("i"), h("i"), h("i")))
						) : null)
				),
				h("div", { className: "hp_aiDock" },
					h("div", { className: "hp_aiInputWrap" },
						h("textarea", { placeholder: AI_PERSONA_PLACEHOLDER[aiPersona] || t("aiPlaceholder"), value: aiInput, onChange: (e) => setAiInput(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { if (e.isComposing || e.keyCode === 229) return; e.preventDefault(); doAiSend(); } }, maxLength: 4000, rows: 1, spellCheck: false }),
						h("button", { className: "hp_aiSend", title: t("aiSend"), disabled: aiRunning || !aiInput.trim(), onClick: doAiSend },
							h("svg", { viewBox: "0 0 20 20", fill: "none" }, h("path", { d: "M3.5 10L16.5 3.5L12.5 16.5L9.5 11.5L3.5 10Z", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" }))
						)
					),
					h("div", { className: "hp_aiDockNote" },
						h("span", null, t("aiModelNow") + "：" + aiModel + "（" + (AI_PROVIDER_LABEL[aiProvider] || aiProvider) + "）" + (aiKey ? "" : " · " + t("aiKeyMissing"))),
						h("span", { style: { flex: 1 } }),
						h("span", null, t("aiEnterHint"))
					)
				)
			);
			const renderMemory = () => h("div", null,
				notice ? h("p", { className: "hp_notice", "data-kind": notice.kind }, notice.text) : null,
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("memTitle"))),
					h("p", { className: "hp_info" }, t("memIntro")),
					data ? h("div", { className: "hp_kv" },
						h("span", null, t("checkMemory") + ":"),
						h("span", { className: "hp_code" }, data.memoryDir || (data.memory && data.memory.dir) || (data.home + "/memory-hub"))
					) : null
				),
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("memPacks"))),
					// FD-1：真实记忆包（memory.packs 来自 status 的 memory-hub 摘要）；
					// 此前渲染 data.store.entries（hotplug-store 插件缓存目录）属假数据。
					data && data.memory && Array.isArray(data.memory.packs) && data.memory.packs.length > 0
						? h("div", { className: "hp_list" }, data.memory.packs.map((pack) =>
							h("div", { key: pack.id, className: "hp_row" },
								h("div", { className: "hp_rowTop" },
									h("span", { className: "hp_name" }, pack.id),
									h("span", { className: "hp_tag" }, `${pack.entries} ${t("memEntries")}`)
								)
							)
						))
						: h("p", { className: "hp_empty" }, t("memEmpty") + (data ? (data.memoryDir || (data.memory && data.memory.dir) || (data.home + "/memory-hub")) : "…"))
				)
			);
			const renderCheck = () => h("div", null,
				notice ? h("p", { className: "hp_notice", "data-kind": notice.kind }, notice.text) : null,
				h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("checkTitle"))),
					h("p", { className: "hp_info" }, t("checkIntro")),
					h("div", { className: "hp_bar" },
						h("button", { className: "hp_btn hp_primary", onClick: doCheck, disabled: busy }, t("checkRecheck"))
					)
				),
				checkData ? h("div", { className: "hp_card" },
					h("div", { className: "hp_list" },
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": checkData.manifestOk ? "reused" : "error" }),
							h("span", null, t("checkManifest")),
							h("span", { className: "hp_val" }, checkData.manifestOk ? t("checkOk") : t("checkErr"))
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": checkData.patchOk ? "reused" : "error" }),
							h("span", null, t("checkPatch")),
							h("span", { className: "hp_val" }, checkData.patchOk ? t("checkOk") : t("checkErr"))
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": "reused" }),
							h("span", null, t("checkNode")),
							h("span", { className: "hp_val" }, checkData.nodeVersion ?? "?")
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": checkData.pnpmVersion ? "reused" : "error" }),
							h("span", null, t("checkPnpm")),
							h("span", { className: "hp_val" }, checkData.pnpmVersion ?? t("checkErr"))
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": "reused" }),
							h("span", null, t("checkVersion")),
							h("span", { className: "hp_val" }, "v" + checkData.version)
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": "reused" }),
							h("span", null, t("checkPacks")),
							h("span", { className: "hp_val" }, String(checkData.packCount))
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": "reused" }),
							h("span", null, t("checkStore")),
							h("span", { className: "hp_val" }, String(checkData.storeCount))
						),
						h("div", { className: "hp_check" },
							h("span", { className: "hp_dot", "data-kind": checkData.conflicts.length ? "error" : "reused" }),
							h("span", null, t("checkActivePack")),
							h("span", { className: "hp_val" }, checkData.activePack ?? t("activeNone"))
						)
					)
				) : null,
				checkData && checkData.conflicts.length > 0 ? h("div", { className: "hp_card" },
					h("div", { className: "hp_heading" }, h("h3", null, t("checkConflicts"))),
					h("div", { className: "hp_list" },
						checkData.conflicts.map((conflict, index) =>
							h("div", { key: index, className: "hp_row" },
								h("div", { className: "hp_rowTop" },
									h("span", { className: "hp_name" }, conflict.packId),
									h("span", { className: "hp_tag", style: { color: "var(--dsw-alias-state-error-primary)" } }, t("checkErr"))
								),
								h("div", { className: "hp_meta" }, conflict.reason),
								h("div", { className: "hp_meta" }, conflict.suggest)
							)
						)
					)
				) : (checkData ? h("div", { className: "hp_card" }, h("p", { className: "hp_info" }, t("checkNoConflicts"))) : null)
			);
			return h("div", { className: "hp_section" },
				h("div", { className: "hp_tabs" },
					tabs.map((tabItem) => h("button", {
						key: tabItem.id, className: "hp_tab", "data-on": tab === tabItem.id,
						onClick: () => {
							setTab(tabItem.id);
							if (tabItem.id === "check" && !checkData) doCheck();
							if (tabItem.id === "market" && !marketData && !marketError && !marketLoading) doMarketSearch();
						}
					}, tabItem.label))
				),
				tab === "hub" ? renderHub() : null,
				tab === "market" ? renderMarket() : null,
				tab === "ai" ? renderAi() : null,
				tab === "memory" ? renderMemory() : null,
				tab === "check" ? renderCheck() : null
			);
		}
		const inject = ["slots", "locale", "remote"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-hotplug-hub: dictionaries");
			const t = ctx.locale.bind(NS);
			let mountFailure = null;
			const mountPromise = ctx.remote.$mount(REMOTE).then((dispose) => {
				ctx.effect(() => dispose, "dsh-hotplug-hub: remote face");
				return true;
			}, (error) => {
				mountFailure = String((error && error.message) || error);
				console.error("dsh-hotplug-hub: remote face mount failed", error);
				return false;
			});
			const remote = async () => {
				await mountPromise;
				if (mountFailure !== null) throw new Error("dshHotplug 远程接口未就绪: " + mountFailure);
				const service = ctx.get("remote.dshHotplug");
				if (service === void 0 || service === null || typeof service !== "object") {
					await new Promise((resolve) => setTimeout(resolve, 50));
					const retry = ctx.get("remote.dshHotplug");
					if (retry === void 0 || retry === null || typeof retry !== "object") throw new Error("dshHotplug 远程接口未注册");
					return retry;
				}
				return service;
			};
			const injected = () => ({
				status: () => remote().then((face) => face.status()),
				importPack: (text) => remote().then((face) => face.importPack(text)),
				preview: (packId) => remote().then((face) => face.preview(packId)),
				activate: (packId) => remote().then((face) => face.activate(packId)),
				deactivate: () => remote().then((face) => face.deactivate()),
				removePack: (packId) => remote().then((face) => face.removePack(packId)),
				check: () => remote().then((face) => face.check()),
				marketList: (params) => remote().then((face) => face.marketList(params)),
				marketDetail: (params) => remote().then((face) => face.marketDetail(params)),
				aiAssemble: (params) => remote().then((face) => face.aiAssemble(params)),
				aiChat: (params) => remote().then((face) => face.aiChat(params)),
				aiTest: (params) => remote().then((face) => (typeof face.aiTest === "function" ? face.aiTest(params) : Promise.reject(new Error("aiTest unavailable"))))
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-hotplug-hub",
				order: 35,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, HotplugTab));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
