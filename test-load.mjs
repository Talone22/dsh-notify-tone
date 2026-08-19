// dsh-notify-tone 加载与触发逻辑验证脚本（Node 环境模拟浏览器）
// 运行：node test-load.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "lib", "client.js"), "utf8");

// ---- 模拟浏览器环境 ----
let oscillatorStarts = 0; // 声音振荡器计数
const fxEl = { // 视觉层元素 mock（记录 play 次数）
	style: { setProperty() {} },
	offsetWidth: 0,
	playCount: 0,
	classList: {
		add(c) { if (c === "play") fxEl.playCount += 1; },
		remove() {},
	},
};
const elements = new Map(); // id -> element
const documentListeners = {};

function makeEl() {
	return {
		style: { cssText: "" },
		textContent: "",
		innerHTML: "",
		children: [],
		appendChild() {},
		setAttribute() {},
		addEventListener() {},
		classList: { add() {}, remove() {}, toggle() {} },
		contains() { return false; },
	};
}

globalThis.localStorage = {
	store: new Map(),
	getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
	setItem(k, v) { this.store.set(k, String(v)); },
	removeItem(k) { this.store.delete(k); },
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

// Notification mock：记录创建的通知与权限请求
globalThis.Notification = class {
	static permission = "granted";
	static calls = [];
	static requestPermissionCalls = 0;
	constructor(title, opts) { Notification.calls.push({ title, opts }); }
	close() {}
	static requestPermission() { Notification.requestPermissionCalls += 1; return Promise.resolve("granted"); }
};

globalThis.document = {
	getElementById(id) {
		if (id === fxEl.id) return fxEl;
		return elements.get(id) ?? null;
	},
	createElement: makeEl,
	addEventListener(type, fn) { documentListeners[type] = fn; },
	head: { appendChild() {} },
	body: { appendChild() {} },
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

// ---- 预设 / 开关 / 颜色持久化测试 ----
const t = exported.__test;
if (!t || Object.keys(t.PRESETS).length < 5) throw new Error("FAIL: 提示音预设不足（应含 5 套，含尖锐警示）");
if (t.PRESETS.sharp && t.PRESETS.sharp.wave !== "square") throw new Error("FAIL: sharp 预设应为 square 波形（尖锐）");
for (const id of t.PRESET_IDS) {
	const p = t.PRESETS[id];
	if (!Array.isArray(p.interact.tones) || !Array.isArray(p.done.tones)) throw new Error(`FAIL: 预设 ${id} 缺音色`);
}
t.setPresetId("bogus");
if (t.currentPresetId() !== t.DEFAULT_PRESET && !t.PRESET_IDS.includes(t.currentPresetId())) throw new Error("FAIL: 非法预设应被忽略");
t.setPresetId("bright");
if (t.currentPresetId() !== "bright") throw new Error("FAIL: setPresetId/currentPresetId 失效");
t.setPresetId("classic");

// 声音 / 视觉默认开启
if (t.isSoundEnabled() !== true) throw new Error("FAIL: 声音应默认开启");
if (t.isVisualEnabled() !== true) throw new Error("FAIL: 视觉应默认开启");

// 双功能独立配色
t.setInteractHue(200);
t.setDoneHue(10);
if (t.interactHue() !== 200) throw new Error("FAIL: interact 颜色设置失效");
if (t.doneHue() !== 10) throw new Error("FAIL: done 颜色设置失效（应与 interact 独立）");
t.setInteractHue(35);
t.setDoneHue(145);
if (t.interactHue() !== 35 || t.doneHue() !== 145) throw new Error("FAIL: 颜色持久化失效");
console.log("PASS: 预设/开关/双功能独立配色 持久化正常");

// 旧 key 迁移（模拟全新加载：新 key 不存在时才迁移）
localStorage.store.delete("dsh.notify-tone.enabled");
localStorage.store.delete("dsh.notify-tone.sound.preset");
localStorage.store.set("dsh.notify-sound.enabled", "false");
localStorage.store.set("dsh.notify-sound.preset", "soft");
const exported2 = captured.factory(() => { throw new Error("x"); }); // 重新执行工厂触发迁移
if (exported2.__test.isEnabled() !== false) throw new Error("FAIL: 旧 enabled key 未迁移");
if (exported2.__test.currentPresetId() !== "soft") throw new Error("FAIL: 旧 preset key 未迁移");
if (localStorage.store.has("dsh.notify-sound.enabled")) throw new Error("FAIL: 旧 key 未清理");
exported2.__test.setEnabled(true);

// 后续场景统一使用第二个实例（apply 在其上执行，节流/基线都在它的闭包里）
const t2 = exported2.__test;
console.log("PASS: 旧版 key 自动迁移正常");

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

exported2.apply(mockCtx);
if (!subscriber) throw new Error("FAIL: apply 未订阅 sessions.list");
if (!fxEl.id || !elements.has(fxEl.id) && fxEl.id !== t.FX_ID) {
	// apply 内部通过 document.getElementById(FX_ID) 查 fxEl——若未挂载则 playFx 无效。
	// 我们的 mock 中 fxEl.id 未设置，直接手动关联：
	fxEl.id = t.FX_ID;
	elements.set(t.FX_ID, fxEl);
}
console.log("PASS: apply 已订阅 sessions.list（基线建立，无发声无视觉）");

// 场景1：需要授权（pending 从无到有）→ 声音 + 视觉 + 系统通知同时触发
oscillatorStarts = 0;
fxEl.playCount = 0;
Notification.calls = [];
snapshot.byId.s1.pendingInteraction = "approval";
subscriber();
if (oscillatorStarts < 2) throw new Error(`FAIL: 授权提醒应播放声音，实际 ${oscillatorStarts} 振荡器`);
if (fxEl.playCount < 1) throw new Error("FAIL: 授权提醒应触发视觉光效");
if (Notification.calls.length < 1) throw new Error("FAIL: 授权提醒应弹系统通知");
console.log("PASS: 授权提醒 = 声音 + 视觉 + 系统通知同时触发");

// 场景2：回答完成（running true->false）→ 声音 + 视觉
oscillatorStarts = 0;
fxEl.playCount = 0;
snapshot.byId.s1.pendingInteraction = undefined;
snapshot.byId.s1.running = false;
subscriber();
if (oscillatorStarts < 2) throw new Error("FAIL: 回答结束应播放声音");
if (fxEl.playCount < 1) throw new Error("FAIL: 回答结束应触发视觉光效");
console.log("PASS: 回答完成提醒 = 声音 + 视觉同时触发");

// 场景3：节流（2 秒内重复 done 不重复触发）
oscillatorStarts = 0;
fxEl.playCount = 0;
snapshot.byId.s1.running = true;
subscriber();
snapshot.byId.s1.running = false;
subscriber();
if (oscillatorStarts !== 0 || fxEl.playCount !== 0) throw new Error("FAIL: 节流内不应触发");
console.log("PASS: 节流生效（声音与视觉同步节流）");

// 场景4：只关声音 → 只有视觉
t2.setSoundEnabled(false);
t2.setVisualEnabled(true);
t2.resetThrottle();
oscillatorStarts = 0;
fxEl.playCount = 0;
snapshot.byId.s1.running = true;
subscriber();
snapshot.byId.s1.pendingInteraction = "question";
subscriber();
if (oscillatorStarts !== 0) throw new Error(`FAIL: 声音关闭时不应发声，实际 ${oscillatorStarts}`);
if (fxEl.playCount < 1) throw new Error("FAIL: 声音关闭时视觉仍应触发");
console.log("PASS: 声音/视觉独立开关（关声音 → 仅视觉）");

// 场景5：只关视觉 → 只有声音（通知仍触发）
t2.setSoundEnabled(true);
t2.setVisualEnabled(false);
t2.resetThrottle();
oscillatorStarts = 0;
fxEl.playCount = 0;
Notification.calls = [];
snapshot.byId.s1.pendingInteraction = undefined;
subscriber();
snapshot.byId.s1.pendingInteraction = "plan-review";
subscriber();
if (oscillatorStarts < 2) throw new Error("FAIL: 视觉关闭时声音仍应触发");
if (fxEl.playCount !== 0) throw new Error("FAIL: 视觉关闭时不应有光效");
if (Notification.calls.length < 1) throw new Error("FAIL: 关视觉时系统通知仍应触发");
console.log("PASS: 声音/视觉独立开关（关视觉 → 仅声音+通知）");

// 场景6：总开关关闭 → 全部静默（含通知）
t2.setVisualEnabled(true);
t2.setEnabled(false);
t2.resetThrottle();
oscillatorStarts = 0;
fxEl.playCount = 0;
Notification.calls = [];
snapshot.byId.s1.pendingInteraction = undefined;
subscriber();
snapshot.byId.s1.pendingInteraction = "approval";
subscriber();
if (oscillatorStarts !== 0 || fxEl.playCount !== 0) throw new Error("FAIL: 总开关关闭时应全部静默");
if (Notification.calls.length !== 0) throw new Error("FAIL: 总开关关闭时不应弹通知");
t2.setEnabled(true);
console.log("PASS: 总开关关闭 → 声音/视觉/通知全部静默");

// 场景7：只关系统通知 → 声音视觉仍在
t2.setNotificationEnabled(false);
t2.resetThrottle();
oscillatorStarts = 0;
fxEl.playCount = 0;
Notification.calls = [];
snapshot.byId.s1.pendingInteraction = undefined;
subscriber();
snapshot.byId.s1.pendingInteraction = "approval";
subscriber();
if (oscillatorStarts < 2) throw new Error("FAIL: 关通知时声音仍应触发");
if (fxEl.playCount < 1) throw new Error("FAIL: 关通知时视觉仍应触发");
if (Notification.calls.length !== 0) throw new Error("FAIL: 通知开关关闭时不应弹通知");
t2.setNotificationEnabled(true);
console.log("PASS: 系统通知独立开关（关通知 → 声音+视觉仍在）");

// 场景8：新会话首次出现不误报
oscillatorStarts = 0;
fxEl.playCount = 0;
snapshot.ids = ["s1", "s2"];
snapshot.byId.s2 = { running: true };
subscriber();
if (oscillatorStarts !== 0 || fxEl.playCount !== 0) throw new Error("FAIL: 新会话首次出现不应误报");
console.log("PASS: 新会话首次出现不误报");

// 清理 disposer
for (const un of disposers) if (typeof un === "function") un();
console.log("ALL PASS ✔  dsh-notify-tone client.js 加载与触发逻辑正常（声音 + 视觉 + 系统通知）");
