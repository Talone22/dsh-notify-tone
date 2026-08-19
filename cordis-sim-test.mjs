// 用真实 @deepseek-ai/cordis 验证「inject 服务名 → fiber 激活」链路，
// 模拟 web boot 中 loader entry 激活插件的过程（提供 sessions 服务后应激活，不 pending）。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cordisRequire = createRequire("C:/Users/Talone/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/");
const { Context, Service } = cordisRequire("@deepseek-ai/cordis");

// ---- 浏览器 mock（同 test-load.mjs）----
let oscillatorStarts = 0;
globalThis.localStorage = { store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }, setItem(k, v) { this.store.set(k, String(v)); } };
globalThis.window = {
	AudioContext: class {
		state = "running"; currentTime = 0; destination = {};
		createOscillator() { return { type: "sine", frequency: { setValueAtTime() {} }, connect() { return this; }, start() { oscillatorStarts += 1; }, stop() {} }; }
		createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; }
		resume() { return Promise.resolve(); }
	},
};
const fakeBody = { appendChild() {} };
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }), body: fakeBody, addEventListener() {} };

// ---- 加载 bundle ----
let captured = null;
globalThis.window.__ModuleLoader__ = { load(h) { captured = h; } };
new Function(readFileSync(join(here, "lib", "client.js"), "utf8"))();
const plugin = captured.factory(() => { throw new Error("不应 require 任何模块"); });

// ---- 用真实 cordis 创建上下文并模拟提供 sessions 服务 ----
const ctx = new Context();
const sessionsService = { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } };
ctx.reflect.provide("sessions", sessionsService, void 0);

// 模拟 dsh-client-runtime 挂载（真实代码里 runtime 会 provide sessions）
console.log("ctx.get('sessions') =", ctx.get("sessions") === sessionsService ? "已提供 ✓" : "缺失 ✗");

// ---- 模拟 loader entry 激活（registry.plugin 等价于 loader 的 _start）----
const fiber = ctx.registry.plugin(plugin, {}, () => []);
let settled = false;
try {
	await fiber.await();
	settled = true;
} catch (error) {
	console.error("fiber 激活失败:", error);
}
if (!settled) throw new Error("FAIL: 插件 fiber 未能激活（inject 服务未满足？）");
console.log("PASS: 真实 cordis fiber 激活成功（inject=[sessions] 被满足，无 pending）");

console.log("ALL PASS ✔  真实 cordis 链路验证通过（服务注入 + fiber 激活）");
