// dsh-notify-tone 加载与触发逻辑验证脚本（Node 环境模拟浏览器）
// 运行：node test-load.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "lib", "client.js"), "utf8");

// ---- 模拟浏览器环境 ----
let oscillatorStarts = 0; // 记录振荡器 start 调用次数（每音符 2 个：基频+泛音）

globalThis.localStorage = {
	store: new Map(),
	getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
	setItem(k, v) { this.store.set(k, String(v)); },
};

globalThis.window = {
	AudioContext: class {
		state = "running";
		currentTime = 0;
		destination = {};
		createOscillator() {
			return {
				type: "sine",
				frequency: { setValueAtTime() {} },
				connect() { return this; },
				start() { oscillatorStarts += 1; },
				stop() {},
			};
		}
		createGain() {
			return {
				gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
				connect() { return this; },
			};
		}
		resume() { return Promise.resolve(); }
	},
};

// document 最小 mock（满足 mountToggle / renderMenu / warmupAudio）
const fakeBody = { appendChild() {} };
globalThis.document = {
	getElementById: () => null,
	createElement: () => ({
		style: {},
		textContent: "",
		appendChild() {},
		addEventListener() {},
		setAttribute() {},
		contains() { return false; },
	}),
	body: fakeBody,
	addEventListener() {},
};

// ---- 执行 bundle，捕获 factory ----
let captured = null;
globalThis.window.__ModuleLoader__ = {
	load(handoff) { captured = handoff; },
};
new Function(clientSrc)();
if (!captured || captured.id !== "dsh-notify-tone") {
	throw new Error("FAIL: bundle 未通过 __ModuleLoader__.load 注册 dsh-notify-tone");
}
const exported = captured.factory((spec) => {
	throw new Error(`FAIL: bundle 不应 require 任何模块，实际 require("${spec}")`);
});
if (typeof exported.apply !== "function") throw new Error("FAIL: exports.apply 缺失");
if (!Array.isArray(exported.inject) || exported.inject[0] !== "sessions") {
	throw new Error("FAIL: exports.inject 不正确（应为服务名 sessions）");
}
console.log("PASS: bundle 注册与 exports 结构正确，inject =", exported.inject);

// ---- 预设与持久化测试（通过 __test 钩子） ----
const t = exported.__test;
if (!t || Object.keys(t.PRESETS).length < 3) throw new Error("FAIL: 提示音预设不足");
if (t.DEFAULT_PRESET !== "ding") throw new Error("FAIL: 默认预设应为 ding（清脆叮咚）");
t.setPresetId("bright");
if (t.currentPresetId() !== "bright") throw new Error("FAIL: setPresetId/currentPresetId 失效");
t.setPresetId("bogus");
if (t.currentPresetId() !== "bright") throw new Error("FAIL: 非法预设应被忽略");
t.setPresetId("classic");
t.setEnabled(false);
if (t.isEnabled() !== false) throw new Error("FAIL: setEnabled(false) 未持久化");
t.setEnabled(true);
if (t.isEnabled() !== true) throw new Error("FAIL: setEnabled(true) 未持久化");
// 每个预设都应有 interact 和 done 两组音符
for (const id of t.PRESET_IDS) {
	const p = t.PRESETS[id];
	if (!Array.isArray(p.interact.tones) || !Array.isArray(p.done.tones)) throw new Error(`FAIL: 预设 ${id} 缺音色`);
}
console.log("PASS: 预设结构完整（", t.PRESET_IDS.join(", "), "），默认 =", t.DEFAULT_PRESET, "，切换/持久化正常");

// ---- 模拟 ctx 并驱动状态变化 ----
let subscriber = null;
const snapshot = {
	ids: ["s1"],
	byId: { s1: { running: true, title: "会话A" } },
};
const disposers = [];
const mockCtx = {
	sessions: {
		list: {
			getSnapshot: () => snapshot,
			subscribe: (fn) => { subscriber = fn; return () => { subscriber = null; }; },
		},
	},
	effect(fn) { const un = fn(); disposers.push(un); return un; },
};

exported.apply(mockCtx);
if (!subscriber) throw new Error("FAIL: apply 未订阅 sessions.list");
console.log("PASS: apply 已订阅 sessions.list（基线建立，无发声）");

// 场景1：AI 需要授权（pendingInteraction 从无到有）→ 应发声（每音符 2 振荡器）
oscillatorStarts = 0;
snapshot.byId.s1.pendingInteraction = "approval";
subscriber();
if (oscillatorStarts < 2) throw new Error(`FAIL: 授权提醒应播放提示音，实际 ${oscillatorStarts} 个振荡器`);
console.log("PASS: 授权/选择提醒触发（approval → 提示音）");

// 场景2：授权解决 + 本轮结束（running true->false）→ 应发声
oscillatorStarts = 0;
snapshot.byId.s1.pendingInteraction = undefined;
snapshot.byId.s1.running = false;
subscriber();
if (oscillatorStarts < 2) throw new Error(`FAIL: 回答结束应播放提示音，实际 ${oscillatorStarts} 个振荡器`);
console.log("PASS: 回答结束提醒触发（running true->false → 提示音）");

// 场景3：节流——1 秒内重复的 done 事件不重复发声
oscillatorStarts = 0;
snapshot.byId.s1.running = true;
subscriber(); // 基线更新
snapshot.byId.s1.running = false;
subscriber();
if (oscillatorStarts !== 0) throw new Error(`FAIL: 节流内不应发声，实际 ${oscillatorStarts}`);
console.log("PASS: 节流生效（2 秒内重复结束不重复发声）");

// 场景4：开关关闭后不发声
t.setEnabled(false);
oscillatorStarts = 0;
snapshot.byId.s1.running = true;
subscriber();
snapshot.byId.s1.pendingInteraction = "question";
subscriber();
if (oscillatorStarts !== 0) throw new Error(`FAIL: 开关关闭时不应发声，实际 ${oscillatorStarts}`);
console.log("PASS: 开关关闭时静默（只更新基线）");

// 场景5：重新打开开关 + 新会话首次出现不发声
t.setEnabled(true);
oscillatorStarts = 0;
snapshot.ids = ["s1", "s2"];
snapshot.byId.s2 = { running: true };
subscriber();
if (oscillatorStarts !== 0) throw new Error(`FAIL: 新会话首次出现不应发声，实际 ${oscillatorStarts}`);
console.log("PASS: 新会话首次出现不误报");

// 场景6：切换预设后发声使用新预设（bright 的 interact 是 3 音符 = 6 振荡器）
t.setPresetId("bright");
snapshot.ids = ["s1"];
delete snapshot.byId.s2;
snapshot.byId.s1.pendingInteraction = undefined;
subscriber(); // 基线同步（先清除之前场景残留的 pending）
t.resetThrottle(); // 清除前面场景的节流时间戳
oscillatorStarts = 0;
snapshot.byId.s1.pendingInteraction = "plan-review";
subscriber();
if (oscillatorStarts !== 6) throw new Error(`FAIL: bright 预设 interact 应为 3 音符 6 振荡器，实际 ${oscillatorStarts}`);
console.log("PASS: 预设切换生效（bright 三连音 → 6 振荡器）");

// 清理 disposer（应无异常）
for (const un of disposers) if (typeof un === "function") un();
console.log("ALL PASS ✔  dsh-notify-tone client.js 加载与触发逻辑正常");
