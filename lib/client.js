// dsh-notify-tone — 浏览器端（web GUI）插件。
//
// 功能：
//   1. AI 执行任务中需要用户授权/选择时（sandbox 授权弹窗、ask_user_question、
//      plan review 等，即会话出现 pendingInteraction）触发「需要操作」提醒；
//   2. AI 每轮回答结束时（会话 running -> false）触发「回答完成」提醒。
//   3. 提醒 = 声音 + 视觉，可分别开关：
//      - 声音：多套内置音色（经典双音 / 清脆叮咚 / 明亮三连 / 柔和轻音），
//        用 Web Audio 合成（基频 + 泛音，无需音频文件）；
//      - 视觉：屏幕四周大圆弧光带 + 泡泡式弹性向内挤压脉冲，
//        「需要操作」「回答完成」各自独立配色（预设 8 色 + 自定义色相）。
//   4. 鼠标悬停 🔔 按钮弹出设置菜单：总开关、声音/视觉分别开关、
//      音色选择（点击试听）、颜色选择（点击预览）。
//
// 实现要点：
//   - 零依赖：不 require 任何 dsh 客户端模块，只用注入的 ctx.sessions 服务。
//   - 所有设置存 localStorage，持久生效；旧版 key（dsh.notify-sound.*）自动迁移。
//   - 不改动 dsh 任何原有组件：只做「监听 + 发声 + 视觉层 + 一个悬浮按钮/菜单」。

window.__ModuleLoader__.load({
	id: "dsh-notify-tone",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ===================== 常量 =====================
		const KEY_ENABLED = "dsh.notify-tone.enabled";
		const KEY_SOUND_ENABLED = "dsh.notify-tone.sound.enabled";
		const KEY_PRESET = "dsh.notify-tone.sound.preset";
		const KEY_VISUAL_ENABLED = "dsh.notify-tone.visual.enabled";
		const KEY_HUE_INTERACT = "dsh.notify-tone.visual.interactHue";
		const KEY_HUE_DONE = "dsh.notify-tone.visual.doneHue";
		const KEY_NOTIFICATION_ENABLED = "dsh.notify-tone.notification.enabled";

		const ROOT_ID = "dsh-notify-tone-root";
		const TOGGLE_ID = "dsh-notify-tone-toggle";
		const MENU_ID = "dsh-notify-tone-menu";
		const FX_ID = "dsh-notify-tone-fx";
		const FX_STYLE_ID = "dsh-notify-tone-fx-style";
		const KEY_POSITION = "dsh.notify-tone.ui.position"; // 🔔 按钮位置（JSON: {left, top}）

		// 菜单定位器：mountToggle 内注册 positionMenu，renderMenu 重建内容后可刷新位置。
		// 用间接层是因为 renderMenu 与 positionMenu 不在同一函数作用域。
		let menuPositioner = null;

		// ===================== 提示音预设 =====================
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
			sharp: {
				label: "尖锐警示",
				wave: "square",
				volume: 0.26,
				interact: { tones: [[1760, 0.09], [2093, 0.09], [2637, 0.16]], gap: 0.06 },
				done: { tones: [[2093, 0.28]], gap: 0 },
			},
		};
		const PRESET_IDS = Object.keys(PRESETS);
		const DEFAULT_PRESET = "ding";

		// 预设颜色（色相值），与 demo 一致
		const COLOR_PRESETS = [35, 15, 0, 320, 270, 215, 180, 145];
		const DEFAULT_HUE_INTERACT = 35;
		const DEFAULT_HUE_DONE = 145;

		// 视觉固定参数（demo 确认过的默认值；暂不提供菜单滑块，保持简洁）
		const VISUAL = { amp: "26px", glow: "0.55", dur: "1.3s", radius: "34px" };

		// ===================== 旧版设置迁移（dsh.notify-sound.* → dsh.notify-tone.*） =====================
		(function migrateOldKeys() {
			try {
				const map = {
					"dsh.notify-sound.enabled": KEY_ENABLED,
					"dsh.notify-sound.preset": KEY_PRESET,
				};
				for (const [oldKey, newKey] of Object.entries(map)) {
					if (localStorage.getItem(oldKey) !== null && localStorage.getItem(newKey) === null) {
						localStorage.setItem(newKey, localStorage.getItem(oldKey));
						localStorage.removeItem(oldKey);
					}
				}
			} catch {
				/* 迁移失败不影响使用 */
			}
		})();

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
		 * @param wave - 波形（sine/square/triangle/sawtooth），尖锐音用 square。
		 */
		function playTone(ctx, freq, dur, start, volume, wave) {
			const stop = start + dur + 0.05;
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = wave ?? "sine";
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
			osc2.type = wave ?? "sine";
			osc2.frequency.setValueAtTime(freq * 2, start);
			gain2.gain.setValueAtTime(0.0001, start);
			gain2.gain.exponentialRampToValueAtTime(volume * 0.35, start + 0.02);
			gain2.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.8);
			osc2.connect(gain2);
			gain2.connect(ctx.destination);
			osc2.start(start);
			osc2.stop(stop);
		}

		/** 按音符序列播放一组提示音（支持预设波形与音量）。 */
		function playPreset(tones, gap, wave, volume) {
			const ctx = ensureAudio();
			if (ctx === null) return;
			const vol = volume ?? 0.22;
			let t = ctx.currentTime + 0.02;
			for (const [freq, dur] of tones) {
				playTone(ctx, freq, dur, t, vol, wave);
				t += dur + (gap ?? 0);
			}
		}

		// ===================== 视觉层 CSS（注入 <style>） =====================
		const FX_CSS = `
#${FX_ID} {
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  --hue: 35;
  --amp: ${VISUAL.amp};
  --glow: ${VISUAL.glow};
  --dur: ${VISUAL.dur};
  --radius: ${VISUAL.radius};
}
#${FX_ID} .halo {
  position: absolute; inset: 0;
  border-radius: var(--radius);
  opacity: 0;
  box-shadow:
    inset 0 0 calc(150px * var(--glow)) calc(22px * var(--glow)) hsla(var(--hue), 90%, 62%, calc(var(--glow) * 0.5)),
    inset 0 0 calc(50px * var(--glow)) calc(10px * var(--glow)) hsla(var(--hue), 95%, 70%, calc(var(--glow) * 0.4));
}
#${FX_ID} .arc {
  position: absolute;
  opacity: 0;
  filter: blur(3px);
}
#${FX_ID} .arc.top {
  top: -40px; left: -8%; right: -8%; height: 280px;
  background: radial-gradient(150% 100% at 50% 0%, hsla(var(--hue), 95%, 74%, calc(var(--glow) * 0.95)), transparent 60%);
}
#${FX_ID} .arc.bottom {
  bottom: -40px; left: -8%; right: -8%; height: 280px;
  background: radial-gradient(150% 100% at 50% 100%, hsla(var(--hue), 95%, 74%, calc(var(--glow) * 0.95)), transparent 60%);
}
#${FX_ID} .arc.left {
  left: -40px; top: -8%; bottom: -8%; width: 280px;
  background: radial-gradient(100% 150% at 0% 50%, hsla(var(--hue), 95%, 74%, calc(var(--glow) * 0.95)), transparent 60%);
}
#${FX_ID} .arc.right {
  right: -40px; top: -8%; bottom: -8%; width: 280px;
  background: radial-gradient(100% 150% at 100% 50%, hsla(var(--hue), 95%, 74%, calc(var(--glow) * 0.95)), transparent 60%);
}
#${FX_ID}.play .halo { animation: dshnt-halo var(--dur) ease-out forwards; }
#${FX_ID}.play .arc.top { animation: dshnt-pop-top var(--dur) cubic-bezier(.22, 1.5, .36, 1) forwards; }
#${FX_ID}.play .arc.bottom { animation: dshnt-pop-bottom var(--dur) cubic-bezier(.22, 1.5, .36, 1) forwards; }
#${FX_ID}.play .arc.left { animation: dshnt-pop-left var(--dur) cubic-bezier(.22, 1.5, .36, 1) forwards; }
#${FX_ID}.play .arc.right { animation: dshnt-pop-right var(--dur) cubic-bezier(.22, 1.5, .36, 1) forwards; }
@keyframes dshnt-halo {
  0% { opacity: 0; }
  12% { opacity: calc(var(--glow)); }
  40% { opacity: calc(var(--glow) * 1.0); }
  72% { opacity: calc(var(--glow) * 0.5); }
  100% { opacity: 0; }
}
@keyframes dshnt-pop-top {
  0% { opacity: 0; transform: translateY(0); }
  10% { opacity: 1; }
  38% { opacity: 1; transform: translateY(var(--amp)); }
  62% { transform: translateY(calc(var(--amp) * -0.12)); }
  82% { transform: translateY(0); }
  100% { opacity: 0; }
}
@keyframes dshnt-pop-bottom {
  0% { opacity: 0; transform: translateY(0); }
  10% { opacity: 1; }
  38% { opacity: 1; transform: translateY(calc(var(--amp) * -1)); }
  62% { transform: translateY(calc(var(--amp) * 0.12)); }
  82% { transform: translateY(0); }
  100% { opacity: 0; }
}
@keyframes dshnt-pop-left {
  0% { opacity: 0; transform: translateX(0); }
  10% { opacity: 1; }
  38% { opacity: 1; transform: translateX(var(--amp)); }
  62% { transform: translateX(calc(var(--amp) * -0.12)); }
  82% { transform: translateX(0); }
  100% { opacity: 0; }
}
@keyframes dshnt-pop-right {
  0% { opacity: 0; transform: translateX(0); }
  10% { opacity: 1; }
  38% { opacity: 1; transform: translateX(calc(var(--amp) * -1)); }
  62% { transform: translateX(calc(var(--amp) * 0.12)); }
  82% { transform: translateX(0); }
  100% { opacity: 0; }
}
`;

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

		// 总开关
		function isEnabled() {
			return storageGet(KEY_ENABLED, "true") !== "false";
		}
		function setEnabled(value) {
			storageSet(KEY_ENABLED, value ? "true" : "false");
		}

		// 声音开关
		function isSoundEnabled() {
			return storageGet(KEY_SOUND_ENABLED, "true") !== "false";
		}
		function setSoundEnabled(value) {
			storageSet(KEY_SOUND_ENABLED, value ? "true" : "false");
		}

		// 视觉开关
		function isVisualEnabled() {
			return storageGet(KEY_VISUAL_ENABLED, "true") !== "false";
		}
		function setVisualEnabled(value) {
			storageSet(KEY_VISUAL_ENABLED, value ? "true" : "false");
		}

		// 音色预设
		function currentPresetId() {
			const id = storageGet(KEY_PRESET, DEFAULT_PRESET);
			return PRESETS[id] ? id : DEFAULT_PRESET;
		}
		function setPresetId(id) {
			if (PRESETS[id]) storageSet(KEY_PRESET, id);
		}

		// 各功能颜色（色相）
		function interactHue() {
			const v = Number(storageGet(KEY_HUE_INTERACT, String(DEFAULT_HUE_INTERACT)));
			return Number.isFinite(v) ? v : DEFAULT_HUE_INTERACT;
		}
		function doneHue() {
			const v = Number(storageGet(KEY_HUE_DONE, String(DEFAULT_HUE_DONE)));
			return Number.isFinite(v) ? v : DEFAULT_HUE_DONE;
		}
		function setInteractHue(h) {
			if (Number.isFinite(h)) storageSet(KEY_HUE_INTERACT, String(Math.round(h)));
		}
		function setDoneHue(h) {
			if (Number.isFinite(h)) storageSet(KEY_HUE_DONE, String(Math.round(h)));
		}

		// 系统通知开关
		function isNotificationEnabled() {
			return storageGet(KEY_NOTIFICATION_ENABLED, "true") !== "false";
		}
		function setNotificationEnabled(value) {
			storageSet(KEY_NOTIFICATION_ENABLED, value ? "true" : "false");
		}

		// ===================== 系统通知（桌面通知，浏览器外可见） =====================
		/** 若权限未定，请求一次通知权限（需在用户交互后调用才有效）。 */
		function ensureNotificationPermission() {
			if (typeof Notification === "undefined") return;
			if (Notification.permission === "default" && typeof Notification.requestPermission === "function") {
				Notification.requestPermission().catch(() => {});
			}
		}

		/** 弹桌面系统通知（任何窗口下都能看到；随系统声音提醒）。 */
		function notifyUser(kind) {
			if (typeof Notification === "undefined") return;
			if (Notification.permission !== "granted") return;
			const isInteract = kind === "interact";
			try {
				const n = new Notification(
					isInteract ? "dsh：AI 需要你的操作" : "dsh：AI 回答完成",
					{
						body: isInteract
							? "有授权或选择等待处理，请回到 dsh 窗口"
							: "本轮回答已生成，可以回来查看了",
						tag: "dsh-notify-tone",
					}
				);
				n.onclick = () => {
					try {
						if (typeof window !== "undefined" && typeof window.focus === "function") window.focus();
					} catch { /* 忽略 */ }
					n.close();
				};
			} catch {
				/* 通知被浏览器拦截时静默 */
			}
		}

		// ===================== 事件节流（防连发） =====================
		const lastPlayed = { interact: 0, done: 0 };
		function throttledPlay(kind, minGapMs) {
			if (!isEnabled()) return;
			const now = Date.now();
			if (now - lastPlayed[kind] < minGapMs) return;
			lastPlayed[kind] = now;
			// 声音 + 视觉 + 系统通知同时触发（各自可独立开关）
			if (isSoundEnabled()) {
				const preset = PRESETS[currentPresetId()];
				const spec = preset[kind];
				playPreset(spec.tones, spec.gap, preset.wave, preset.volume);
			}
			if (isVisualEnabled()) {
				playFx(kind);
			}
			if (isNotificationEnabled()) {
				notifyUser(kind);
			}
		}

		// ===================== 会话状态订阅 =====================
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
				if (prev.pending === undefined && cur.pending !== undefined) {
					throttledPlay("interact", 1200);
				}
				if (prev.running && !cur.running) {
					throttledPlay("done", 2000);
				}
			}
			for (const id of prevBySession.keys()) {
				if (!now.has(id)) prevBySession.delete(id);
			}
			prevBySession = now;
		}

		// ===================== 视觉层（挂载 + 播放） =====================
		function mountFx() {
			if (typeof document === "undefined") return;
			if (document.getElementById(FX_ID)) return;
			if (!document.body || !document.head) {
				document.addEventListener("DOMContentLoaded", mountFx, { once: true });
				return;
			}
			if (!document.getElementById(FX_STYLE_ID)) {
				const style = document.createElement("style");
				style.id = FX_STYLE_ID;
				style.textContent = FX_CSS;
				document.head.appendChild(style);
			}
			const root = document.createElement("div");
			root.id = FX_ID;
			root.innerHTML =
				'<div class="halo"></div>' +
				'<div class="arc top"></div>' +
				'<div class="arc bottom"></div>' +
				'<div class="arc left"></div>' +
				'<div class="arc right"></div>';
			document.body.appendChild(root);
		}

		function playFx(kind) {
			if (typeof document === "undefined") return;
			const root = document.getElementById(FX_ID);
			if (!root) return;
			root.style.setProperty("--hue", kind === "interact" ? interactHue() : doneHue());
			root.classList.remove("play");
			void root.offsetWidth; // 强制 reflow 重启动画
			root.classList.add("play");
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
				? "提醒已开启。鼠标悬停可设置声音/视觉/颜色"
				: "提醒已关闭。鼠标悬停可设置";
			btn.setAttribute("aria-label", on ? "提醒已开启" : "提醒已关闭");
			btn.style.opacity = on ? "0.9" : "0.55";
		}

		// 菜单内通用小组件
		function switchButton(current, onToggle) {
			const btn = el("button", current ? "已开启" : "已关闭",
				"font-family:system-ui,sans-serif;border:1px solid rgba(128,128,128,0.4);background:rgba(255,255,255,0.08);color:#e8e8ea;border-radius:6px;padding:1px 9px;cursor:pointer;font-size:12px;");
			btn.addEventListener("click", (event) => {
				event.stopPropagation();
				onToggle(!current);
			});
			return btn;
		}

		function presetButtons(onPick) {
			const wrap = el("div", "", "display:flex;flex-wrap:wrap;gap:5px;margin-top:4px;");
			for (const id of PRESET_IDS) {
				const p = PRESETS[id];
				const sel = id === currentPresetId();
				const b = el("button", p.label,
					"font-family:system-ui,sans-serif;font-size:11px;border-radius:6px;padding:3px 8px;cursor:pointer;border:1px solid " +
					(sel ? "rgba(122,184,255,0.9)" : "rgba(128,128,128,0.35)") + ";" +
					(sel ? "background:rgba(64,128,255,0.28);color:#dbe9ff;" : "background:rgba(255,255,255,0.06);color:#e8e8ea;"));
				b.addEventListener("click", (event) => {
					event.stopPropagation();
					onPick(id);
				});
				wrap.appendChild(b);
			}
			return wrap;
		}

		/**
		 * 颜色选择器：预设色块 + 自定义色相滑块。
		 * @param currentHue - 当前色相。
		 * @param onPick - 颜色变化回调（只改值 + 预览，不重建菜单，保证滑块可连续拖动）。
		 * @param onCommitted - 提交回调（重建菜单刷新选中态；色块点击与滑块松手时调用）。
		 */
		function colorPicker(currentHue, onPick, onCommitted) {
			const wrap = el("div", "", "display:flex;flex-direction:column;gap:4px;margin-top:4px;");
			const dots = el("div", "", "display:flex;gap:4px;flex-wrap:wrap;");
			for (const h of COLOR_PRESETS) {
				const sel = Math.abs(h - currentHue) < 2;
				const d = el("div", "", "width:16px;height:16px;border-radius:50%;cursor:pointer;flex:none;background:hsl(" + h + " 85% 60%);border:1px solid rgba(255,255,255,0.35);box-sizing:border-box;" + (sel ? "outline:2px solid #fff;outline-offset:1px;" : ""));
				d.addEventListener("click", (event) => {
					event.stopPropagation();
					onPick(h);
					if (typeof onCommitted === "function") onCommitted();
				});
				dots.appendChild(d);
			}
			wrap.appendChild(dots);
			const hueRow = el("div", "", "display:flex;align-items:center;gap:6px;");
			hueRow.appendChild(el("span", "🌈", "font-size:12px;"));
			const slider = document.createElement("input");
			slider.type = "range";
			slider.min = "0";
			slider.max = "360";
			slider.step = "1";
			slider.value = String(Math.round(currentHue));
			slider.style.cssText = "flex:1;accent-color:#58a6ff;height:18px;";
			slider.addEventListener("input", () => {
				onPick(Number(slider.value)); // 拖动中只改色+预览，不重建菜单
			});
			slider.addEventListener("change", () => {
				if (typeof onCommitted === "function") onCommitted(); // 松手后重建刷新 UI
			});
			hueRow.appendChild(slider);
			wrap.appendChild(hueRow);
			return wrap;
		}

		let expandedColor = null; // "interact" | "done" | null（菜单中当前展开的颜色选择器）

		function renderMenu(menu, btn) {
			updateToggle(btn);
			menu.textContent = "";
			const base = "font-family:system-ui,-apple-system,sans-serif;";

			menu.appendChild(el("div", "🔔 提醒设置", base + "font-weight:600;font-size:13px;margin-bottom:8px;"));

			// —— 总开关 ——
			const masterRow = el("div", "", base + "display:flex;justify-content:space-between;align-items:center;padding:4px 2px;");
			masterRow.appendChild(el("span", "功能开关"));
			masterRow.appendChild(switchButton(isEnabled(), (next) => {
				setEnabled(next);
				renderMenu(menu, btn);
				if (next && isSoundEnabled()) {
					const preset = PRESETS[currentPresetId()];
					const spec = preset.done;
					playPreset(spec.tones, spec.gap, preset.wave, preset.volume);
				}
			}));
			menu.appendChild(masterRow);

			menu.appendChild(el("div", "", "border-top:1px solid rgba(128,128,128,0.22);margin:7px 0;"));

			// —— 声音提醒 ——
			const soundRow = el("div", "", base + "display:flex;justify-content:space-between;align-items:center;padding:4px 2px;");
			soundRow.appendChild(el("span", "声音提醒"));
			soundRow.appendChild(switchButton(isSoundEnabled(), (next) => {
				setSoundEnabled(next);
				renderMenu(menu, btn);
				if (next) {
					const preset = PRESETS[currentPresetId()];
					const spec = preset.done;
					playPreset(spec.tones, spec.gap, preset.wave, preset.volume);
				}
			}));
			menu.appendChild(soundRow);
			if (isSoundEnabled()) {
				menu.appendChild(presetButtons((id) => {
					setPresetId(id);
					const preset = PRESETS[id];
					const spec = preset.interact;
					playPreset(spec.tones, spec.gap, preset.wave, preset.volume); // 点击音色试听
					renderMenu(menu, btn);
				}));
			}

			menu.appendChild(el("div", "", "border-top:1px solid rgba(128,128,128,0.22);margin:7px 0;"));

			// —— 视觉提醒 ——
			const visualRow = el("div", "", base + "display:flex;justify-content:space-between;align-items:center;padding:4px 2px;");
			visualRow.appendChild(el("span", "视觉提醒"));
			visualRow.appendChild(switchButton(isVisualEnabled(), (next) => {
				setVisualEnabled(next);
				renderMenu(menu, btn);
				if (next) playFx("done");
			}));
			menu.appendChild(visualRow);

			if (isVisualEnabled()) {
				// 「需要操作」颜色
				const iRow = el("div", "", base + "display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer;");
				const iDot = el("span", "", "width:13px;height:13px;border-radius:50%;flex:none;background:hsl(" + interactHue() + " 85% 60%);");
				iRow.appendChild(iDot);
				iRow.appendChild(el("span", "需要操作", base + "flex:1;font-size:12px;"));
				const iBtn = el("button", expandedColor === "interact" ? "▴" : "▾", base + "border:none;background:transparent;color:#7ab8ff;cursor:pointer;font-size:12px;");
				iRow.appendChild(iBtn);
				iRow.addEventListener("click", (event) => {
					// 必须阻止冒泡：renderMenu 会移除本元素，事件若冒泡到 document
					// 的「点击外部关闭」监听，contains(已移除元素) 为 false 会误关菜单
					event.stopPropagation();
					expandedColor = expandedColor === "interact" ? null : "interact";
					renderMenu(menu, btn);
				});
				menu.appendChild(iRow);
				if (expandedColor === "interact") {
					menu.appendChild(colorPicker(interactHue(),
						(h) => { // onPick：改色 + 预览，不重建（滑块可连续拖动）
							setInteractHue(h);
							playFx("interact");
						},
						() => renderMenu(menu, btn) // onCommitted：提交后重建刷新选中态
					));
				}

				// 「回答完成」颜色
				const dRow = el("div", "", base + "display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer;");
				const dDot = el("span", "", "width:13px;height:13px;border-radius:50%;flex:none;background:hsl(" + doneHue() + " 85% 60%);");
				dRow.appendChild(dDot);
				dRow.appendChild(el("span", "回答完成", base + "flex:1;font-size:12px;"));
				const dBtn = el("button", expandedColor === "done" ? "▴" : "▾", base + "border:none;background:transparent;color:#7ab8ff;cursor:pointer;font-size:12px;");
				dRow.appendChild(dBtn);
				dRow.addEventListener("click", (event) => {
					event.stopPropagation(); // 同上：防止重建后误关菜单
					expandedColor = expandedColor === "done" ? null : "done";
					renderMenu(menu, btn);
				});
				menu.appendChild(dRow);
				if (expandedColor === "done") {
					menu.appendChild(colorPicker(doneHue(),
						(h) => {
							setDoneHue(h);
							playFx("done");
						},
						() => renderMenu(menu, btn)
					));
				}
			}

			menu.appendChild(el("div", "", "border-top:1px solid rgba(128,128,128,0.22);margin:7px 0;"));

			// —— 系统通知 ——
			const notifRow = el("div", "", base + "display:flex;justify-content:space-between;align-items:center;padding:4px 2px;");
			notifRow.appendChild(el("span", "系统通知"));
			notifRow.appendChild(switchButton(isNotificationEnabled(), (next) => {
				setNotificationEnabled(next);
				if (next) ensureNotificationPermission(); // 打开时若未授权则请求权限
				renderMenu(menu, btn);
			}));
			menu.appendChild(notifRow);
			if (typeof Notification !== "undefined" && Notification.permission === "denied") {
				menu.appendChild(el("div", "⚠ 通知权限已在浏览器设置中禁用，请到浏览器站点设置中开启", base + "color:rgba(255,160,120,0.9);font-size:11px;padding:1px 2px 4px;"));
			} else if (typeof Notification !== "undefined" && Notification.permission === "default" && isNotificationEnabled()) {
				menu.appendChild(el("div", "ℹ 尚未授权：打开开关或点击上方任意提醒会请求通知权限", base + "color:rgba(255,255,255,0.45);font-size:11px;padding:1px 2px 4px;"));
			}

			menu.appendChild(el("div", "声音 / 视觉 / 系统通知 各自独立开关；颜色各功能独立", base + "color:rgba(255,255,255,0.45);font-size:11px;margin-top:8px;"));

			// 内容重建后（如展开颜色面板导致宽度变化）若菜单正在显示，则重新定位，
			// 确保水平/垂直方向始终适配屏幕边缘
			if (menu.style.display !== "none" && typeof menuPositioner === "function") {
				menuPositioner();
			}
		}

		function mountToggle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(ROOT_ID)) return;
			if (!document.body) {
				document.addEventListener("DOMContentLoaded", mountToggle, { once: true });
				return;
			}

			// touch-action:none 防止触屏拖动时页面滚动
			const root = el("div", "", "position:fixed;right:18px;bottom:18px;z-index:2147483001;display:flex;flex-direction:column;align-items:flex-end;touch-action:none;");
			root.id = ROOT_ID; // 必须设置 id：幂等检查 getElementById(ROOT_ID) 依赖它，否则重复 apply 会挂出多个铃铛

			// 菜单绝对定位（相对 root），由 positionMenu() 动态决定向上/向下弹出，
			// 避免按钮靠近屏幕边缘时菜单被裁剪或遮挡按钮
			const menu = el("div", "", "display:none;position:absolute;right:0;min-width:240px;max-height:64vh;overflow-y:auto;background:rgba(24,24,30,0.96);border:1px solid rgba(128,128,128,0.3);border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,0.45);backdrop-filter:blur(6px);color:#e8e8ea;");
			root.appendChild(menu);

			const btn = el("button", "🔔", "width:38px;height:38px;border-radius:50%;border:1px solid rgba(128,128,128,0.35);background:rgba(28,28,34,0.75);color:#fff;font-size:18px;line-height:1;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.35);backdrop-filter:blur(4px);transition:opacity .15s ease;");
			btn.id = TOGGLE_ID;
			btn.type = "button";
			btn.title = "拖动可移动位置；点击开/关；悬停打开设置菜单";

			let hideTimer = null;
			let dragState = null;
			let suppressClick = false;

			// 根据按钮位置决定菜单弹出方向：
			//  - 垂直：上方空间不足且下方更大 → 向下弹出，否则向上弹出
			//  - 水平：默认右对齐向左展开（right:0）；若左侧空间不足以容纳菜单宽度，
			//    则切换为左对齐向右展开（left:0），避免菜单被屏幕左边缘裁剪
			function positionMenu() {
				if (typeof window === "undefined") return;
				const vw = window.innerWidth || 0;
				const vh = window.innerHeight || 0;
				const rect = typeof btn.getBoundingClientRect === "function" ? btn.getBoundingClientRect() : null;
				const spaceAbove = rect ? rect.top : vh;
				const spaceBelow = rect ? vh - rect.bottom : 0;
				const spaceLeft = rect ? rect.left : vw;
				const spaceRight = rect ? vw - rect.right : 0;
				const menuMaxH = (vh * 64) / 100; // 与 max-height 对齐
				const menuW = menu.offsetWidth || 240; // 菜单真实宽度；隐藏时回退到 min-width
				if (spaceAbove < menuMaxH && spaceBelow > spaceAbove) {
					// 上方空间不足且下方更大 → 向下弹出
					menu.style.top = "calc(100% + 8px)";
					menu.style.bottom = "auto";
				} else {
					// 默认向上弹出
					menu.style.top = "auto";
					menu.style.bottom = "calc(100% + 8px)";
				}
				if (spaceLeft >= menuW) {
					// 左侧空间充足 → 右对齐向左展开（默认）
					menu.style.left = "auto";
					menu.style.right = "0";
				} else if (spaceRight >= menuW) {
					// 左侧不足但右侧充足 → 左对齐向右展开，避免被左边缘裁剪
					menu.style.right = "auto";
					menu.style.left = "0";
				} else {
					// 两侧都不足（极窄窗口）→ 选空间较大的一侧
					if (spaceRight > spaceLeft) {
						menu.style.right = "auto";
						menu.style.left = "0";
					} else {
						menu.style.left = "auto";
						menu.style.right = "0";
					}
				}
			}

			menuPositioner = positionMenu; // 注册到间接层，供 renderMenu 重建内容后刷新位置

			// 恢复上次保存的位置（持久化）
			function applyStoredPosition() {
				try {
					const raw = storageGet(KEY_POSITION, "");
					if (!raw) return;
					const pos = JSON.parse(raw);
					if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
						root.style.left = pos.left + "px";
						root.style.top = pos.top + "px";
						root.style.right = "auto";
						root.style.bottom = "auto";
					}
				} catch {
					/* 位置数据损坏时忽略，使用默认位置 */
				}
			}

			// —— 🔔 拖拽移动（Pointer Events，鼠标/触屏通用）——
			btn.addEventListener("pointerdown", (event) => {
				if (event.button !== undefined && event.button !== 0) return; // 仅左键/触摸
				event.preventDefault();
				clearTimeout(hideTimer); // 拖动时收起菜单
				menu.style.display = "none";
				expandedColor = null;
				dragState = {
					startX: event.clientX,
					startY: event.clientY,
					left: root.offsetLeft,
					top: root.offsetTop,
					moved: false,
				};
				btn.style.cursor = "grabbing";
				if (typeof btn.setPointerCapture === "function") {
					try { btn.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
				}
			});

			btn.addEventListener("pointermove", (event) => {
				if (!dragState) return;
				event.preventDefault();
				const dx = event.clientX - dragState.startX;
				const dy = event.clientY - dragState.startY;
				if (!dragState.moved && Math.hypot(dx, dy) < 4) return; // 4px 内视为点击
				dragState.moved = true;
				// 限制在可视区域内
				const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
				const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
				const bw = root.offsetWidth || 40;
				const bh = root.offsetHeight || 40;
				const left = Math.min(Math.max(0, dragState.left + dx), Math.max(0, vw - bw));
				const top = Math.min(Math.max(0, dragState.top + dy), Math.max(0, vh - bh));
				root.style.left = left + "px";
				root.style.top = top + "px";
				root.style.right = "auto";
				root.style.bottom = "auto";
			});

			function endDrag() {
				if (!dragState) return;
				const moved = dragState.moved;
				dragState = null;
				btn.style.cursor = "grab";
				if (moved) {
					suppressClick = true; // 拖动后抑制随后的 click（避免误切换开关）
					try {
						storageSet(KEY_POSITION, JSON.stringify({ left: root.offsetLeft, top: root.offsetTop }));
					} catch { /* 忽略 */ }
				}
			}
			btn.addEventListener("pointerup", endDrag);
			btn.addEventListener("pointercancel", endDrag);

			btn.addEventListener("click", (event) => {
				event.stopPropagation();
				if (suppressClick) { suppressClick = false; return; } // 拖拽结束后的 click 不切换开关
				const next = !isEnabled();
				setEnabled(next);
				updateToggle(btn);
				renderMenu(menu, btn);
				if (next && isSoundEnabled()) {
					const preset = PRESETS[currentPresetId()];
					const spec = preset.done;
					playPreset(spec.tones, spec.gap, preset.wave, preset.volume);
				}
			});
			root.appendChild(btn);

			document.body.appendChild(root);
			applyStoredPosition(); // 恢复持久化的位置

			root.addEventListener("mouseenter", () => {
				clearTimeout(hideTimer);
				renderMenu(menu, btn);
				menu.style.display = "block";
				positionMenu(); // 先显示再定位：此时 offsetWidth 为菜单真实宽度，水平/垂直方向判断更准确
			});
			root.addEventListener("mouseleave", () => {
				clearTimeout(hideTimer);
				hideTimer = setTimeout(() => {
					menu.style.display = "none";
					expandedColor = null;
				}, 300);
			});
			document.addEventListener("click", (event) => {
				if (!root.contains(event.target)) {
					menu.style.display = "none";
					expandedColor = null;
				}
			});
		}

		// 浏览器自动播放策略：需要用户先与页面交互过，AudioContext 才会出声。
		function warmupAudio() {
			if (typeof document === "undefined") return;
			const unlock = () => ensureAudio();
			document.addEventListener("click", unlock, { capture: true, once: true });
			document.addEventListener("keydown", unlock, { capture: true, once: true });
		}

		// ===================== 插件主体 =====================
		// inject 是 cordis「服务名」列表（fiber 等待服务可用才激活），
		// 不是包名/模块 id。sessions 服务由 @deepseek-ai/dsh-client-runtime 提供。
		const inject = ["sessions"];

		function apply(ctx) {
			const list = ctx && ctx.sessions && ctx.sessions.list;
			if (list && typeof list.subscribe === "function") {
				ctx.effect(() => {
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
				console.warn("[dsh-notify-tone] ctx.sessions.list 不可用，提醒功能未启用");
			}

			mountFx();
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
			isSoundEnabled,
			setSoundEnabled,
			isVisualEnabled,
			setVisualEnabled,
			isNotificationEnabled,
			setNotificationEnabled,
			notifyUser,
			ensureNotificationPermission,
			interactHue,
			doneHue,
			setInteractHue,
			setDoneHue,
			playPreset,
			playTone,
			ensureAudio,
			playFx,
			FX_ID,
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
