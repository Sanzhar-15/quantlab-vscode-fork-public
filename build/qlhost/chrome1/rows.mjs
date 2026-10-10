/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-QL-CHROME-1 presence rows P1 P2 P4 P5 on a TEST pack, over CDP (the STRIP mrows connection: DevToolsActivePort in the
// user-data dir, the workbench page target). The runner launches the pack and enters QuantLab its usual way; this script attaches,
// reads the DOM, takes screenshots, writes <out>/chrome1-rows.json and prints one `ROW <id> GREEN|RED <why>` line per row.
// Run on the guest: `node rows.mjs <user-data-dir> <out dir> <app path> <python file name in the open folder>`.
// Exit 0 = every row GREEN · 1 = a row RED · 4 = tool error (nothing judged). No retry: a failure is printed and ends the run.
//
// P1 auxiliary bar hidden (QIC ships OFF: no empty right pane); 0 visible title-bar part; the editor toolbar of a python file holds
//    "Open as Action" (quantlab.openAsAction) and "Open as Chart" (quantlab.openAsChart) (titles: extensions/quantlab/package.nls.json).
// P2 0 notification toasts from first paint to settle (12 s), max over the period; run once per launch (3 launches).
// P4 the workbench carries the Delta Plus dark theme class and the editor background equals the shipped delta_plus_dark.json value
//    (the theme file's regeneration from the token file is the static half: `node extensions/quantlab/themes/generate.mjs --check`).
// P5 no editor tab whose label contains "Welcome" at first open (read before the python file is opened).
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const [ud, out, app, pyFile] = process.argv.slice(2);
if (!ud || !out || !app || !pyFile) { console.log('FAIL=usage: rows.mjs <user-data-dir> <out dir> <app path> <python file name>'); process.exit(64); }
const R = { started: new Date().toISOString(), args: { ud, out, app, pyFile }, rows: {} };
const save = () => fs.writeFileSync(path.join(out, 'chrome1-rows.json'), JSON.stringify(R, null, 1));
const fail = (m) => { console.log(`FAIL=${m}`); R.toolError = m; save(); process.exit(4); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => { const f = path.join(out, `${name}.png`); execFileSync('/usr/sbin/screencapture', ['-x', f]); return `${name}.png`; };
async function until(what, ms, fn) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() > end) { fail(`timed out after ${ms} ms waiting for ${what}`); } await sleep(200); } }

const themeFile = path.join(app, 'Contents/Resources/app/extensions/theme-defaults/themes/delta_plus_dark.json');
if (!fs.existsSync(themeFile)) { fail(`no shipped theme at ${themeFile}`); }
const shippedEditorBg = JSON.parse(fs.readFileSync(themeFile, 'utf8')).colors['editor.background'];
if (!/^#[0-9a-fA-F]{6}$/.test(shippedEditorBg ?? '')) { fail(`shipped editor.background is not #rrggbb: ${shippedEditorBg}`); }
const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;

const portFile = path.join(ud, 'DevToolsActivePort');
const port = await until('DevToolsActivePort', 90000, () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
const page = await until('workbench page target', 90000, async () => {
	let list; try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { console.log(`json/list not yet: ${e.message}`); return null; }
	return list.find((x) => x.type === 'page' && /workbench(\.esm)?\.html/.test(x.url));
});
R.target = page.url;
const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = (e) => rej(new Error(`ws ${e.message ?? e.type}`)); });
let seq = 0; const pend = new Map();
sock.onmessage = (m) => { const r = JSON.parse(m.data); const p = pend.get(r.id); if (p) { pend.delete(r.id); r.error ? p.rej(new Error(JSON.stringify(r.error))) : p.res(r.result); } };
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); sock.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error(`${method} timeout`)); } }, 10000); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) { fail(`eval threw: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`); } return r.result.value; };
const verdict = (id, green, why) => { R.rows[id] = { ...(R.rows[id] ?? {}), verdict: green ? 'GREEN' : 'RED', why }; console.log(`ROW ${id} ${green ? 'GREEN' : 'RED'} ${why}`); };

// P2: toasts sampled every 200 ms from the first workbench paint until 12 s later; the maximum count and every toast text seen.
await until('workbench DOM', 60000, () => ev(`!!document.querySelector('.monaco-workbench .part.editor')`));
R.rows.P2 = { firstPaintShot: shot('P2-first-paint'), samples: 0, maxToasts: 0, texts: [] };
const p2End = Date.now() + 12000;
while (Date.now() < p2End) {
	const t = await ev(`[...document.querySelectorAll('.notifications-toasts .notification-toast-container')].map(e => e.textContent.trim().slice(0, 300))`);
	R.rows.P2.samples++; R.rows.P2.maxToasts = Math.max(R.rows.P2.maxToasts, t.length);
	for (const s of t) { if (!R.rows.P2.texts.includes(s)) { R.rows.P2.texts.push(s); } }
	await sleep(200);
}
R.rows.P2.settledShot = shot('P2-settled');
verdict('P2', R.rows.P2.maxToasts === 0, `max toasts ${R.rows.P2.maxToasts} over ${R.rows.P2.samples} samples${R.rows.P2.texts.length ? `: ${JSON.stringify(R.rows.P2.texts)}` : ''}`);

// P5: tab labels at first open, before anything is opened.
R.rows.P5 = { tabs: await ev(`[...document.querySelectorAll('.tabs-container .tab')].map(e => e.getAttribute('aria-label') || e.textContent.trim())`), shot: shot('P5-first-open') };
const welcome = R.rows.P5.tabs.filter((t) => /welcome/i.test(t));
verdict('P5', welcome.length === 0, `tabs ${JSON.stringify(R.rows.P5.tabs)}`);

// P4: theme class on the workbench element + the editor background variable against the shipped file.
R.rows.P4 = await ev(`(() => { const wb = document.querySelector('.monaco-workbench'); return { classes: wb.className,
	editorBg: getComputedStyle(wb).getPropertyValue('--vscode-editor-background').trim(),
	editorPartBg: getComputedStyle(document.querySelector('.part.editor > .content') ?? document.querySelector('.part.editor')).backgroundColor }; })()`);
R.rows.P4.shippedEditorBg = shippedEditorBg;
const themeOk = /\bvscode-theme-defaults-themes-delta_plus_dark-json\b/.test(R.rows.P4.classes);
const bgOk = R.rows.P4.editorBg.toLowerCase() === shippedEditorBg.toLowerCase() && R.rows.P4.editorPartBg === hexToRgb(shippedEditorBg);
verdict('P4', themeOk && bgOk, `theme class ${themeOk ? 'delta_plus_dark' : 'ABSENT'}; --vscode-editor-background ${R.rows.P4.editorBg}, editor part ${R.rows.P4.editorPartBg}, shipped ${shippedEditorBg}`);

// P1: open the python file by Quick Open, then read the right pane, the title-bar part and the editor toolbar.
const key = async (k, code, vk, modifiers) => { for (const type of ['rawKeyDown', 'keyUp']) { await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }); } await sleep(400); };
await key('p', 'KeyP', 80, 4);
await until('quick open', 5000, () => ev(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()`));
await cdp('Input.insertText', { text: pyFile }); await sleep(1200);
await key('Enter', 'Enter', 13, 0);
await until(`an editor tab for ${pyFile}`, 15000, () => ev(`[...document.querySelectorAll('.tabs-container .tab.active')].some(e => (e.getAttribute('aria-label') || '').includes(${JSON.stringify(pyFile)}))`));
await sleep(1500);
R.rows.P1 = await ev(`(() => { const vis = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0 && getComputedStyle(e).display !== 'none';
	const aux = document.querySelector('.part.auxiliarybar'); const title = document.querySelector('.part.titlebar');
	const toolbar = [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item .action-label')].map(e => e.getAttribute('aria-label') || e.textContent.trim()).filter(Boolean);
	return { auxiliaryBarVisible: vis(aux), titleBarPartVisible: vis(title), toolbar }; })()`);
R.rows.P1.shot = shot('P1-python-file');
const has = (label) => R.rows.P1.toolbar.some((t) => t.startsWith(label));
const p1Ok = !R.rows.P1.auxiliaryBarVisible && !R.rows.P1.titleBarPartVisible && has('Open as Action') && has('Open as Chart');
verdict('P1', p1Ok, `aux visible ${R.rows.P1.auxiliaryBarVisible}, title part visible ${R.rows.P1.titleBarPartVisible}, toolbar ${JSON.stringify(R.rows.P1.toolbar)}`);

R.ended = new Date().toISOString(); save(); sock.close();
process.exit(Object.values(R.rows).every((r) => r.verdict === 'GREEN') ? 0 : 1);
