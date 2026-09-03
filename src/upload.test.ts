/**
 * uploadAssets 最小自检（无 HTTP）：stub fetch 捕获 FormData，
 * 验证该部署实测契约——multipart 字段名必须是 file[]（AGENTS.md 第 13 条）。
 * 运行：node --experimental-strip-types src/upload.test.ts
 */

import assert from "node:assert";
import { SiYuanClient } from "./siyuan-client.ts";

// ---- 捕获 fetch ----
let captured: { url: string; init: RequestInit } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
	captured = { url: String(url), init };
	return new Response(
		JSON.stringify({
			code: 0,
			msg: "",
			data: {
				errFiles: null,
				succFiles: [{ index: 0, name: "a.png", path: "assets/a-x.png" }],
				succMap: { "a.png": "assets/a-x.png" },
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}) as typeof fetch;

const client = new SiYuanClient("http://127.0.0.1:6806", "test-token");

// 1. 正常上传：字段名 file[]、Authorization 头、不手工设 multipart Content-Type
const r = await client.uploadAssets([
	{ name: "a.png", data: new Uint8Array([1, 2, 3]), mime: "image/png" },
	{ name: "b.jpg", data: new Uint8Array([4, 5]) },
]);
assert.ok(captured, "fetch 应被调用");
assert.ok(captured!.url.endsWith("/api/asset/upload"), "打到 /api/asset/upload");
assert.equal(
	(captured!.init.headers as any).Authorization,
	"Token test-token",
	"带 Token 认证头",
);
assert.equal(
	(captured!.init.headers as any)["Content-Type"],
	undefined,
	"multipart Content-Type 必须由 fetch 自动生成（含 boundary），不能手工设置",
);
const form = captured!.init.body as FormData;
assert.equal(form.getAll("file[]").length, 2, "两个文件都用 file[] 字段");
assert.equal((form.get("file[]") as File).name, "a.png", "保留原文件名");
assert.deepEqual(r.succMap, { "a.png": "assets/a-x.png" });

// 2. 空 succMap（字段名回归/反代吞 body 的静默失败症状）必须报错
globalThis.fetch = (async () =>
	new Response(
		JSON.stringify({
			code: 0,
			msg: "",
			data: { errFiles: null, failedFiles: [], succFiles: [], succMap: {} },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	)) as typeof fetch;
await assert.rejects(
	() => client.uploadAssets([{ name: "x.png", data: new Uint8Array([1]) }]),
	/空 succMap/,
	"code:0 + 空 succMap 必须抛错（这正是历史上 files[] 被8吞掉的症状）",
);

// 3. 空文件列表直接拒绝
await assert.rejects(
	() => client.uploadAssets([]),
	/文件列表为空/,
);

globalThis.fetch = realFetch;
console.log("upload self-check: all assertions passed ✅");
