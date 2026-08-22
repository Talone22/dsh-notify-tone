// 菜单交互测试：验证「视觉颜色设置」在菜单中可点击生效（修复滑块重建 bug）
// 运行：node test-menu.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "lib", "client.js"), "utf8");

// ---- 较完整的 DOM mock：真实父子关系 + 事件冒泡 + stopPropagation ----
class MockEl {
	constructor(tag) {
		this.tag = tag;
		this.style = { cssText: "", setProperty() {} };
		this._listeners = {};
		this.children = [];
		this.parent = null;
		this._text = "";
		this.innerHTML = "";
		this.id = undefined;
		this.type = undefined;
		this.min = undefined;
		this.max = undefined;
		this.step = undefined;
		this.value = undefined;
		this.classList = {
			_s: new Set(),
			add(c) { this._s.add(c); },
			remove(c) { this._s.delete(c); },
			toggle(c, force) { const on = force ?? !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; },
			contains(c) { return this._s.has(c); },
		};
		this.rect = { top: 500, bottom: 538 }; // 默认屏幕中部
	}
	getBoundingClientRect() { return this.rect; }
	// 模拟浏览器行为：给 textContent 赋值会清空子节点
	get textContent() { return this._text; }
	set textContent(v) {
		this._text = String(v);
		if (this._text === "") this.children = [];
	}
	appendChild(child) { child.parent = this; this.children.push(child); return child; }
	addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
	setAttribute() {}
	dispatch(type, ev = {}) {
		ev.stopPropagation ??= () => { ev._stopped = true; };
		const fns = [...(this._listeners[type] ?? [])];
		for (const fn of fns) {
			fn(ev);
			if (ev._stopped) break;
		}
		if (!ev._stopped && this.parent) this.parent.dispatch(type, ev);
	}
	contains(node) {
		let n = node;
		while (n) { if (n === this) return true; n = n.parent; }
		return false;
	}
}

const fxEl = new MockEl("div"); // 预注册的视觉层元素（记录播放次数）
fxEl.playCount = 0;
const origAdd = fxEl.classList.add.bind(fxEl.classList);
fxEl.classList.add = (c) => { origAdd(c); if (c === "play") fxEl.playCount += 1; };

const elements = new Map();
globalThis.localStorage = {
	store: new Map(),
	getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
	setItem(k, v) { this.store.set(k, String(v)); },
	removeItem(k) { this.store.delete(k); },
};
globalThis.window = { AudioContext: undefined, innerWidth: 800, innerHeight: 600 }; // 菜单测试不涉及声音
globalThis.Notification = class {
	static permission = "granted";
	static requestPermission() { return Promise.resolve("granted"); }
	constructor() {}
	close() {}
};

// document 也参与事件冒泡链（root -> body -> document），模拟「点击外部关闭」监听
const docListeners = {};
const doc = {
	createElement: (tag) => new MockEl(tag),
	getElementById: (id) => elements.get(id) ?? null,
	addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
	dispatch(type, ev) {
		ev.stopPropagation ??= () => {};
		for (const fn of [...(docListeners[type] ?? [])]) fn(ev);
	},
	head: new MockEl("head"),
	body: new MockEl("body"),
};
globalThis.document = doc;
doc.body.parent = doc; // 冒泡链终点
doc.head.parent = doc;

// ---- 加载 bundle ----
let captured = null;
globalThis.window.__ModuleLoader__ = { load(h) { captured = h; } };
new Function(clientSrc)();
const exported = captured.factory(() => { throw new Error("不应 require"); });
const t = exported.__test;
elements.set(t.FX_ID, fxEl);

// ---- apply 并打开菜单 ----
const mockCtx = {
	sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
	effect(fn) { return fn(); },
};
exported.apply(mockCtx);

const root = document.body.children[0];
if (!root || !root.children || root.children.length !== 2) throw new Error("FAIL: 悬浮按钮未挂载（root 应含 menu + btn）");
const menu = root.children[0];
const btn = root.children[1];
root.dispatch("mouseenter");
if (menu.style.display !== "block") throw new Error("FAIL: hover 后菜单未显示");

function findIn(rootEl, pred) {
	const stack = [...rootEl.children];
	while (stack.length) {
		const n = stack.shift();
		if (pred(n)) return n;
		stack.push(...n.children);
	}
	return null;
}

// ---- 1. 展开「需要操作」颜色选择器 ----
const interactSpan = findIn(menu, (n) => n.tag === "span" && n.textContent === "需要操作");
if (!interactSpan) throw new Error("FAIL: 菜单中没有「需要操作」行");
interactSpan.parent.dispatch("click"); // 点击行展开
// 回归：点击颜色行后菜单不应消失（曾因 renderMenu 移除元素 + 冒泡到 document 误关）
if (menu.style.display !== "block") throw new Error("FAIL: 点击颜色行后菜单被误关（冒泡误判为点击外部）");
let picker = findIn(menu, (n) => n.tag === "input" && n.type === "range");
if (!picker) throw new Error("FAIL: 展开后未出现色相滑块");
const dotInteract = findIn(menu, (n) => n.tag === "span" && /background:hsl\(35 /.test(n.style.cssText || ""));
if (!dotInteract) throw new Error("FAIL: 「需要操作」行缺少当前色点");
console.log("PASS: 「需要操作」颜色选择器可展开（滑块出现，初始色点 35°）");

// ---- 2. 点击蓝色色块（215）→ 颜色改变 + 预览 + 重建后选中态更新 ----
const blueDot = findIn(menu, (n) => n.tag === "div" && /background:hsl\(215 /.test(n.style.cssText || ""));
if (!blueDot) throw new Error("FAIL: 未找到蓝色色块");
fxEl.playCount = 0;
blueDot.dispatch("click");
if (t.interactHue() !== 215) throw new Error(`FAIL: 点击色块后 interact 颜色未变，实际 ${t.interactHue()}`);
if (fxEl.playCount < 1) throw new Error("FAIL: 选色后未触发视觉预览");
const dotAfter = findIn(menu, (n) => n.tag === "span" && /background:hsl\(215 /.test(n.style.cssText || ""));
if (!dotAfter) throw new Error("FAIL: 重建后色点未更新为 215°");
console.log("PASS: 点击色块 → 颜色生效(215°) + 视觉预览 + 重建后选中态更新");

// ---- 3. 色相滑块：input 不重建（对象保持），change 重建 ----
const slider = findIn(menu, (n) => n.tag === "input" && n.type === "range");
slider.value = "100";
slider.dispatch("input");
if (t.interactHue() !== 100) throw new Error(`FAIL: 滑块 input 后颜色未变，实际 ${t.interactHue()}`);
const slider2 = findIn(menu, (n) => n.tag === "input" && n.type === "range");
if (slider2 !== slider) throw new Error("FAIL: 滑块拖动时菜单被重建（滑块对象被替换）——这是之前无法调色的 bug");
slider.dispatch("change");
const slider3 = findIn(menu, (n) => n.tag === "input" && n.type === "range");
if (slider3 === slider) throw new Error("FAIL: change 后应重建菜单（刷新选中态）");
console.log("PASS: 色相滑块可连续拖动（input 不重建菜单），松手 change 后重建");

// ---- 4. 「回答完成」颜色独立 ----
const doneSpan = findIn(menu, (n) => n.tag === "span" && n.textContent === "回答完成");
if (!doneSpan) throw new Error("FAIL: 菜单中没有「回答完成」行");
doneSpan.parent.dispatch("click");
const doneDot = findIn(menu, (n) => n.tag === "div" && /background:hsl\(145 /.test(n.style.cssText || ""));
if (!doneDot) throw new Error("FAIL: 「回答完成」未显示默认绿色色块");
doneDot.dispatch("click");
if (t.doneHue() !== 145) throw new Error("FAIL: done 颜色不应受 interact 影响（应保持 145）");
if (t.interactHue() !== 100) throw new Error("FAIL: interact 颜色被 done 操作污染（应保持 100）");
const doneBlue = findIn(menu, (n) => n.tag === "div" && /background:hsl\(320 /.test(n.style.cssText || ""));
doneBlue.dispatch("click");
if (t.doneHue() !== 320) throw new Error("FAIL: done 颜色独立设置失效");
if (t.interactHue() !== 100) throw new Error("FAIL: 改 done 颜色污染了 interact（应各自独立）");
console.log("PASS: 「需要操作」与「回答完成」颜色完全独立");

// ---- 5. 视觉/声音开关按钮可点击 ----
const visualSpan = findIn(menu, (n) => n.tag === "span" && n.textContent === "视觉提醒");
if (!visualSpan) throw new Error("FAIL: 未找到「视觉提醒」行");
const visualSwitch = visualSpan.parent.children.find((c) => c.tag === "button");
if (!visualSwitch) throw new Error("FAIL: 视觉开关按钮缺失");
visualSwitch.dispatch("click");
if (t.isVisualEnabled() !== false) throw new Error("FAIL: 点击后视觉开关未关闭");
// 菜单已重建，重新查找新按钮再点击
const visualSpan2 = findIn(menu, (n) => n.tag === "span" && n.textContent === "视觉提醒");
const visualSwitch2 = visualSpan2.parent.children.find((c) => c.tag === "button");
visualSwitch2.dispatch("click");
if (t.isVisualEnabled() !== true) throw new Error("FAIL: 再点视觉开关未重新开启");
console.log("PASS: 视觉开关按钮点击正常");

// ---- 6. 系统通知开关可点击 ----
const notifSpan = findIn(menu, (n) => n.tag === "span" && n.textContent === "系统通知");
if (!notifSpan) throw new Error("FAIL: 未找到「系统通知」行");
const notifSwitch = notifSpan.parent.children.find((c) => c.tag === "button");
if (!notifSwitch) throw new Error("FAIL: 系统通知开关按钮缺失");
notifSwitch.dispatch("click");
if (t.isNotificationEnabled() !== false) throw new Error("FAIL: 点击后系统通知开关未关闭");
const notifSpan2 = findIn(menu, (n) => n.tag === "span" && n.textContent === "系统通知");
const notifSwitch2 = notifSpan2.parent.children.find((c) => c.tag === "button");
notifSwitch2.dispatch("click");
if (t.isNotificationEnabled() !== true) throw new Error("FAIL: 再点系统通知开关未重新开启");
console.log("PASS: 系统通知开关按钮点击正常");

// ---- 7. 菜单弹出方向自适应（按钮靠近屏幕顶部 → 向下弹出，不被裁剪/遮挡） ----
const btnEl = root.children[1]; // mountToggle 的 root 子元素顺序：menu, btn
btnEl.rect = { top: 10, bottom: 48 }; // 模拟按钮在屏幕顶部
root.dispatch("mouseenter");
if (menu.style.top !== "calc(100% + 8px)") throw new Error("FAIL: 按钮在顶部时菜单应向下弹出");
btnEl.rect = { top: 400, bottom: 438 }; // 模拟按钮在中部
root.dispatch("mouseenter");
if (menu.style.bottom !== "calc(100% + 8px)") throw new Error("FAIL: 按钮在中部时菜单应向上弹出");
console.log("PASS: 菜单弹出方向自适应（顶部→向下，中部→向上）");

// ---- 8. 菜单水平方向自适应（按钮靠近屏幕左边缘 → 向右展开，不被左边缘裁剪） ----
menu.style.display = "none";
// MockEl 无 offsetWidth；菜单 min-width 240 → positionMenu 回退 240
btnEl.rect = { top: 400, bottom: 438, left: 0, right: 38 }; // 模拟按钮贴左边缘
root.dispatch("mouseenter");
if (menu.style.left !== "0" || menu.style.right !== "auto") throw new Error("FAIL: 按钮在左边缘时菜单应 left:0 向右展开");
console.log("PASS: 按钮在左边缘 → 菜单左对齐向右展开（不被裁剪）");
btnEl.rect = { top: 400, bottom: 438, left: 300, right: 338 }; // 左侧空间 300 >= 240
root.dispatch("mouseenter");
if (menu.style.right !== "0" || menu.style.left !== "auto") throw new Error("FAIL: 按钮左侧空间充足时应保持 right:0 向左展开");
console.log("PASS: 按钮左侧空间充足 → 保持右对齐向左展开（默认行为不变）");
btnEl.rect = { top: 400, bottom: 438, left: 760, right: 798 }; // 右侧空间 2 < 240（贴右边缘）
root.dispatch("mouseenter");
if (menu.style.right !== "0" || menu.style.left !== "auto") throw new Error("FAIL: 按钮贴右边缘时左侧空间充足应保持 right:0");
console.log("PASS: 按钮在右边缘 → 保持右对齐向左展开（默认行为不变）");

console.log("ALL PASS ✔  菜单颜色设置交互正常（色块 / 滑块 / 双功能独立配色 / 开关）");
console.log("ALL PASS ✔  菜单颜色设置交互正常（色块 / 滑块 / 双功能独立配色 / 开关）");
