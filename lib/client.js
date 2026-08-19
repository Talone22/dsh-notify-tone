// dsh-notify-tone — 浏览器端（web GUI）插件。
//
// 功能：
//   1. AI 执行任务中需要用户授权/选择时（sandbox 授权弹窗、ask_user_question、
//      plan review 等，即会话出现 pendingInteraction）播放「需要操作」提示音；
//   2. AI 每轮回答结束时（会话 running -> false）播放「回答完成」提示音。
//   3. 多种提示音可选（经典双音 / 清脆叮咚 / 明亮三连 / 柔和轻音），
//      鼠标悬停 🔔 按钮弹出设置菜单：功能开关、提示音选择、点击试听预览。
//
// 实现要点：
//   - 零依赖：不 require 任何 dsh 客户端模块，只用注入的 ctx.sessions 服务
//     与 Web Audio API（无需音频文件）。
//   - 声音更明显：基频 + 泛音合成、指数衰减包络、音量提升。
//   - 开关与所选提示音存 localStorage，持久生效。
//   - 不改动 dsh 任何原有组件：只做「监听 + 发声 + 一个悬浮按钮/菜单」。

window.__ModuleLoader__.load({
	id: "dsh-notify-tone",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ===================== 常量 =====================
		const KEY_ENABLED = "dsh.notify-sound.enabled";
		const KEY_PRESET = "dsh.notify-sound.preset";
		const ROOT_ID = "dsh-notify-tone-root";
		const TOGGLE_ID = "dsh-notify-tone-toggle";
		const MENU_ID = "dsh-notify-tone-menu";

		// ===================== 提示音预设 =====================
		// 每个预设含 interact（需要授权/选择）与 done（回答完成）两组音符。
		// 音符格式：[频率Hz, 时长s]；gap 为音符间隔（秒）。
		const PRESETS = {
			classic: {
				label: "经典双音",
				interact: { tones: [[880, 0.16], [660, 0.16]], gap: 0.08 },
				done: { tones: [[660, 0.14], [880, 0.2]], gap: 0.08 },
			},
			ding: {
				label: "清脆叮咚",
				interact: { tones: [[1046.5, 0.35], [1318.5, 0.35]], gap: 0.1 },
				done: { tones: [[1318.5, 0.5]], gap: 0 },
			},
			bright: {
				label: "明亮三连",
				interact: { tones: [[1568, 0.12], [1976, 0.12], [2637, 0.2]], gap: 0.07 },
				done: { tones: [[1568, 0.16], [1976, 0.16]], gap: 0.07 },
			},
			soft: {
				label: "柔和轻音",
				interact: { tones: [[523, 0.2], [659, 0.25]], gap: 0.09 },
				done: { tones: [[659, 0.28]], gap: 0 },
			},
		};
		const PRESET_IDS = Object.keys(PRESETS);
		/** 默认音色：清脆叮咚（比经典双音更明显，如「叮——」）。 */
		const DEFAULT_PRESET = "ding";

		// ===================== 声音引擎（Web Audio，无音频文件） =====================
		let audioCtx = null;

		function ensureAudio() {
			if (typeof window === "undefined") return null;
			const AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) return null;
			if (audioCtx === null) {
				try {
					audioCtx = new AC();
				} catch {
					return null;
				}
			}
			if (audioCtx.state === "suspended") {
				audioCtx.resume().catch(() => {});
			}
			return audioCtx;
		}

		/**
		 * 播放一个音符：基频 + 2 倍频泛音（更明亮、更明显），指数衰减包络。
		 */
		function playTone(ctx, freq, dur, start, volume) {
			const stop = start + dur + 0.05;
			// 基频
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.setValueAtTime(freq, start);
			gain.gain.setValueAtTime(0.0001, start);
			gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start(start);
			osc.stop(stop);
			// 泛音（2 倍频，音量更低，增强穿透力）
			const osc2 = ctx.createOscillator();
			const gain2 = ctx.createGain();
			osc2.type = "sine";
			osc2.frequency.setValueAtTime(freq * 2, start);
			gain2.gain.setValueAtTime(0.0001, start);
			gain2.gain.exponentialRampToValueAtTime(volume * 0.35, start + 0.02);
			gain2.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.8);
			osc2.connect(gain2);
			gain2.connect(ctx.destination);
			osc2.start(start);
			osc2.stop(stop);
		}

		/** 按音符序列播放一组提示音。 */
		function playPreset(tones, gap) {
			const ctx = ensureAudio();
			if (ctx === null) return;
			const volume = 0.22;
			let t = ctx.currentTime + 0.02;
			for (const [freq, dur] of tones) {
				playTone(ctx, freq, dur, t, volume);
				t += dur + (gap ?? 0);
			}
		}

		// ===================== 状态（localStorage 持久化） =====================
		function storageGet(key, fallback) {
			try {
				const value = localStorage.getItem(key);
				return value === null ? fallback : value;
			} catch {
				return fallback;
			}
		}
		function storageSet(key, value) {
			try {
				localStorage.setItem(key, value);
			} catch {
				/* 存储不可用时仅本页生效 */
			}
		}

		function isEnabled() {
			return storageGet(KEY_ENABLED, "true") !== "false";
		}
		function setEnabled(value) {
			storageSet(KEY_ENABLED, value ? "true" : "false");
		}

		function currentPresetId() {
			const id = storageGet(KEY_PRESET, DEFAULT_PRESET);
			return PRESETS[id] ? id : DEFAULT_PRESET;
		}
		function setPresetId(id) {
			if (PRESETS[id]) storageSet(KEY_PRESET, id);
		}

		// ===================== 事件节流（防连发） =====================
		const lastPlayed = { interact: 0, done: 0 };
		function throttledPlay(kind, minGapMs) {
			if (!isEnabled()) return;
			const now = Date.now();
			if (now - lastPlayed[kind] < minGapMs) return;
			lastPlayed[kind] = now;
			const spec = PRESETS[currentPresetId()][kind];
			playPreset(spec.tones, spec.gap);
		}

		// ===================== 会话状态订阅 =====================
		// 基线：id -> { running, pending }。首次快照只建基线不发声，
		// 避免页面刷新时对「正在运行」的会话误报。
		let prevBySession = new Map();

		function handleListChange(ctx) {
			const list = ctx.sessions && ctx.sessions.list;
			if (!list) return;
			const snap = list.getSnapshot();
			if (!snap || !snap.byId || !Array.isArray(snap.ids)) return;

			const now = new Map();
			for (const id of snap.ids) {
				const row = snap.byId[id];
				if (!row) continue;
				now.set(id, { running: row.running === true, pending: row.pendingInteraction });
			}

			for (const [id, cur] of now) {
				const prev = prevBySession.get(id);
				if (prev === undefined) continue; // 新出现的会话：只入基线
				// 需要用户授权/选择：pendingInteraction 从无到有
				if (prev.pending === undefined && cur.pending !== undefined) {
					throttledPlay("interact", 1200);
				}
				// 每轮回答结束：running true -> false
				if (prev.running && !cur.running) {
					throttledPlay("done", 2000);
				}
			}
			// 已被移除的会话从基线中清理
			for (const id of prevBySession.keys()) {
				if (!now.has(id)) prevBySession.delete(id);
			}
			prevBySession = now;
		}

		// ===================== 悬浮按钮 + hover 设置菜单 =====================
		function el(tag, text, css) {
			const node = document.createElement(tag);
			if (text !== undefined && text !== null) node.textContent = text;
			if (css) node.style.cssText = css;
			return node;
		}

		function updateToggle(btn) {
			const on = isEnabled();
			btn.textContent = on ? "🔔" : "🔕";
			btn.title = on
				? "提示音：已开启。鼠标悬停可设置音色/开关"
				: "提示音：已关闭。鼠标悬停可设置音色/开关";
			btn.setAttribute("aria-label", on ? "提示音已开启" : "提示音已关闭");
			btn.style.opacity = on ? "0.9" : "0.55";
		}

		/** 渲染设置菜单内容（每次调用重建，简单可靠）。 */
		function renderMenu(menu, btn) {
			updateToggle(btn);
			menu.textContent = "";
			const base = "font-family:system-ui,-apple-system,sans-serif;";

			menu.appendChild(el("div", "🔔 提示音设置", `${base}font-weight:600;font-size:13px;margin-bottom:8px;`));

			// —— 功能开关 ——
			const toggleRow = el("div", "", `${base}display:flex;justify-content:space-between;align-items:center;padding:5px 2px;`);
			toggleRow.appendChild(el("span", "功能开关"));
			const sw = el("button", isEnabled() ? "已开启" : "已关闭", `${base}border:1px solid rgba(128,128,128,0.4);background:rgba(255,255,255,0.08);color:#e8e8ea;border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px;`);
			sw.addEventListener("click", (event) => {
				event.stopPropagation();
				const next = !isEnabled();
				setEnabled(next);
				renderMenu(menu, btn);
				if (next) {
					const spec = PRESETS[currentPresetId()].done;
					playPreset(spec.tones, spec.gap); // 打开时试听当前音色的「完成」音
				}
			});
			toggleRow.appendChild(sw);
			menu.appendChild(toggleRow);

			menu.appendChild(el("div", "", "border-top:1px solid rgba(128,128,128,0.22);margin:8px 0;"));

			// —— 提示音选择 ——
			menu.appendChild(el("div", "提示音选择", `${base}font-weight:600;font-size:13px;margin-bottom:6px;`));
			const active = currentPresetId();
			for (const id of PRESET_IDS) {
				const preset = PRESETS[id];
				const selected = id === active;
				const row = el("div", "", `${base}display:flex;justify-content:space-between;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;${selected ? "background:rgba(64,128,255,0.22);" : ""}`);
				row.addEventListener("mouseenter", () => {
					row.style.background = "rgba(255,255,255,0.1)";
				});
				row.addEventListener("mouseleave", () => {
					row.style.background = id === currentPresetId() ? "rgba(64,128,255,0.22)" : "";
				});
				row.appendChild(el("span", preset.label + (selected ? "  ✓" : "")));
				const preview = el("button", "▶ 试听", `${base}border:none;background:transparent;color:#7ab8ff;cursor:pointer;font-size:12px;padding:0 2px;`);
				preview.addEventListener("click", (event) => {
					event.stopPropagation();
					previewSound(id); // 先试听再决定是否应用
				});
				row.addEventListener("click", () => {
					setPresetId(id);
					renderMenu(menu, btn);
				});
				row.appendChild(preview);
				menu.appendChild(row);
			}

			menu.appendChild(el("div", "点击选项选中即生效；▶ 可先试听", `${base}color:rgba(255,255,255,0.45);font-size:11px;margin-top:8px;`));
		}

		/** 试听某预设：连播「需要操作」+「回答完成」两段，让用户听完整效果。 */
		function previewSound(presetId) {
			const preset = PRESETS[presetId];
			if (!preset) return;
			// 两段连播：interact 播完 0.35s 后再播 done
			playPreset(preset.interact.tones, preset.interact.gap);
			const total = preset.interact.tones.reduce((acc, [, dur]) => acc + dur, 0) + preset.interact.gap * (preset.interact.tones.length - 1);
			setTimeout(() => {
				playPreset(preset.done.tones, preset.done.gap);
			}, (total + 0.35) * 1000);
		}

		function mountToggle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(ROOT_ID)) return;
			if (!document.body) {
				document.addEventListener("DOMContentLoaded", mountToggle, { once: true });
				return;
			}

			const root = el("div", "", "position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;");

			const menu = el("div", "", "display:none;margin-bottom:8px;min-width:230px;background:rgba(24,24,30,0.96);border:1px solid rgba(128,128,128,0.3);border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,0.45);backdrop-filter:blur(6px);color:#e8e8ea;");
			root.appendChild(menu);

			const btn = el("button", "🔔", "width:38px;height:38px;border-radius:50%;border:1px solid rgba(128,128,128,0.35);background:rgba(28,28,34,0.75);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.35);backdrop-filter:blur(4px);transition:opacity .15s ease;");
			btn.id = TOGGLE_ID;
			btn.type = "button";
			btn.addEventListener("click", (event) => {
				event.stopPropagation();
				const next = !isEnabled();
				setEnabled(next);
				updateToggle(btn);
				renderMenu(menu, btn);
				if (next) {
					const spec = PRESETS[currentPresetId()].done;
					playPreset(spec.tones, spec.gap);
				}
			});
			root.appendChild(btn);

			document.body.appendChild(root);

			// hover 显示菜单（延迟 120ms），移出后延迟 300ms 关闭（留出移到菜单的时间）
			let hideTimer = null;
			root.addEventListener("mouseenter", () => {
				clearTimeout(hideTimer);
				renderMenu(menu, btn);
				menu.style.display = "block";
			});
			root.addEventListener("mouseleave", () => {
				clearTimeout(hideTimer);
				hideTimer = setTimeout(() => {
					menu.style.display = "none";
				}, 300);
			});
			// 点击菜单外部区域时关闭菜单
			document.addEventListener("click", (event) => {
				if (!root.contains(event.target)) menu.style.display = "none";
			});
		}

		// 浏览器自动播放策略：需要用户先与页面交互过，AudioContext 才会出声。
		// 捕获任意一次用户点击来预热音频上下文。
		function warmupAudio() {
			if (typeof document === "undefined") return;
			const unlock = () => ensureAudio();
			document.addEventListener("click", unlock, { capture: true, once: true });
			document.addEventListener("keydown", unlock, { capture: true, once: true });
		}

		// ===================== 插件主体 =====================
		// 注意：inject 是 cordis「服务名」列表（fiber 会等待这些服务可用才激活），
		// 不是包名/模块 id。sessions 服务由 @deepseek-ai/dsh-client-runtime 提供
		// （rootCtx.reflect.provide("sessions", ...)）。
		const inject = ["sessions"];

		function apply(ctx) {
			// 订阅会话列表状态变化（running / pendingInteraction）
			const list = ctx && ctx.sessions && ctx.sessions.list;
			if (list && typeof list.subscribe === "function") {
				ctx.effect(() => {
					// 先建立基线快照，再订阅后续变化
					const bootstrap = () => {
						const snap = list.getSnapshot();
						prevBySession = new Map();
						if (snap && snap.byId && Array.isArray(snap.ids)) {
							for (const id of snap.ids) {
								const row = snap.byId[id];
								if (row) prevBySession.set(id, { running: row.running === true, pending: row.pendingInteraction });
							}
						}
						return list.subscribe(() => handleListChange(ctx));
					};
					const unsubscribe = bootstrap();
					return () => {
						if (typeof unsubscribe === "function") unsubscribe();
					};
				}, "dsh-notify-tone: sessions subscription");
			} else {
				console.warn("[dsh-notify-tone] ctx.sessions.list 不可用，提示音功能未启用");
			}

			mountToggle();
			warmupAudio();
		}

		// 测试钩子（仅供验证脚本使用；cordis 只消费 apply/inject，额外导出无副作用）
		exports.__test = {
			PRESETS,
			PRESET_IDS,
			DEFAULT_PRESET,
			currentPresetId,
			setPresetId,
			isEnabled,
			setEnabled,
			playPreset,
			playTone,
			ensureAudio,
			resetThrottle() {
				lastPlayed.interact = 0;
				lastPlayed.done = 0;
			},
		};

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
