/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-QL-CHROME-1 presence rows P1 P2 P4 P5 on a TEST pack, over CDP. Run on the guest:
//   node rows.mjs <user-data-dir> <out dir> <app path> <python file name in the open folder>
// Start it right after launching the pack and BEFORE entering QuantLab: it attaches to the browser endpoint (DevToolsActivePort),
// auto-attaches to every new page target paused at start, installs a recorder in the workbench document before any workbench
// script runs, then prints `OBSERVER READY` (enter QuantLab now). The recorder keeps every notification toast element and every
// editor tab label the workbench ever showed, so a toast that expired or a tab that closed is still counted.
// Startup is judged complete only when the Running Extensions editor shows the Quantlab extension's activation time (the workbench
// receives it after the extension's activate() resolved: the first-run Welcome would have been opened inside activate()).
// Exit 0 = every row GREEN · 1 = a row RED · 4 = tool error (missing coverage, broken DOM contract, CDP/IO failure; nothing judged).
//
// P1 auxiliary bar hidden (QIC ships OFF: no empty right pane); no visible title-bar part; the editor toolbar of a python file shows
//    "Open as Action" (quantlab.openAsAction) and "Open as Chart" (quantlab.openAsChart), each visible and enabled.
// P2 0 notification toast elements from the workbench document's start until startup completion + 5 s; once per launch (3 launches).
// P4 the workbench carries the Delta Plus dark theme class and the editor content background equals the shipped delta_plus_dark.json
//    editor.background (the static half: `node extensions/quantlab/themes/generate.mjs --check`).
// P5 no editor tab label containing "Welcome" from the workbench document's start until startup completion + 5 s.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';

const [ud, out, app, pyFile] = process.argv.slice(2);
if (!ud || !out || !app || !pyFile) {
	console.log('FAIL=usage: rows.mjs <user-data-dir> <out dir> <app path> <python file name>');
	process.exit(64);
}
const R = { started: new Date().toISOString(), args: { ud, out, app, pyFile }, attachLog: [], rows: {} };
const save = () => fs.writeFileSync(path.join(out, 'chrome1-rows.json'), JSON.stringify(R, null, 1));
// The one reporting boundary: every operational failure ends here, is written to chrome1-rows.json and exits 4.
function fail(message) {
	console.log(`FAIL=${message}`);
	R.toolError = message;
	R.ended = new Date().toISOString();
	save();
	process.exit(4);
}
const describe = (e) => e instanceof Error ? e.stack : String(e);
process.on('unhandledRejection', (e) => fail(`unhandled rejection: ${describe(e)}`));
process.on('uncaughtException', (e) => fail(`uncaught exception: ${describe(e)}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => {
	const f = path.join(out, `${name}.png`);
	execFileSync('/usr/sbin/screencapture', ['-x', f]);
	if (!fs.existsSync(f)) {
		throw new Error(`screencapture wrote no ${f}`);
	}
	return `${name}.png`;
};
async function until(what, ms, fn) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) {
			return v;
		}
		if (Date.now() > end) {
			throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		}
		await sleep(200);
	}
}
const WORKBENCH_URL = /workbench(\.esm)?\.html/;

// Runs in every new page document before its own scripts; records only in the workbench document.
const RECORDER = `(() => {
	if (!/workbench(\\.esm)?\\.html/.test(location.href) || window.__qlChrome1 !== undefined) { return; }
	const S = window.__qlChrome1 = { installedAt: performance.now(), workbenchAtInstall: !!document.querySelector('.monaco-workbench'), scans: 0, toastElements: 0, toastTexts: [], tabLabels: [] };
	const seenToasts = new WeakSet(); const toastRecords = new Map();
	const scan = () => {
		S.scans++;
		for (const t of document.querySelectorAll('.notifications-toasts .notification-toast-container')) {
			if (!seenToasts.has(t)) { seenToasts.add(t); S.toastElements++; toastRecords.set(t, { at: performance.now(), text: '' }); S.toastTexts.push(toastRecords.get(t)); }
			const text = t.textContent.trim(); if (text) { toastRecords.get(t).text = text.slice(0, 300); }
		}
		for (const t of document.querySelectorAll('.tabs-container .tab')) {
			const label = t.getAttribute('aria-label'); if (label !== null && !S.tabLabels.includes(label)) { S.tabLabels.push(label); }
		}
	};
	let queued = false;
	new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; scan(); }); } })
		.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
})();`;

async function main() {
	const themeFile = path.join(app, 'Contents/Resources/app/extensions/theme-defaults/themes/delta_plus_dark.json');
	const theme = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
	const shippedEditorBg = theme.colors['editor.background'];
	if (typeof shippedEditorBg !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(shippedEditorBg)) {
		throw new Error(`shipped editor.background in ${themeFile} is not #rrggbb: ${JSON.stringify(shippedEditorBg)}`);
	}
	const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;

	// Browser endpoint: line 1 of DevToolsActivePort is the port, line 2 the browser path.
	const portFile = path.join(ud, 'DevToolsActivePort');
	const [port, browserPath] = await until('DevToolsActivePort', 90000, () => {
		if (!fs.existsSync(portFile)) {
			return null;
		}
		const lines = fs.readFileSync(portFile, 'utf8').split('\n').map((l) => l.trim());
		return lines[0] && lines[1] ? lines.slice(0, 2) : null;
	});
	const sock = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
	await new Promise((res, rej) => { sock.onopen = res; sock.onerror = (e) => rej(new Error(`browser websocket error event (${e.type}) on ws://127.0.0.1:${port}${browserPath}`)); });
	let seq = 0; const pend = new Map(); const handlers = new Map();
	sock.onmessage = (m) => {
		const r = JSON.parse(m.data);
		if (r.id !== undefined) {
			const p = pend.get(r.id);
			if (p) {
				pend.delete(r.id);
				if (r.error) {
					p.rej(new Error(`${p.method}: ${JSON.stringify(r.error)}`));
				} else {
					p.res(r.result);
				}
			}
			return;
		}
		const h = handlers.get(r.method);
		if (h) {
			h(r.params, r.sessionId).catch((e) => fail(`${r.method} handler: ${describe(e)}`));
		}
	};
	const cdp = (method, params, sessionId) => new Promise((res, rej) => {
		const id = ++seq; pend.set(id, { res, rej, method });
		sock.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
		setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error(`${method} timed out after 10 s`)); } }, 10000);
	});

	// Coverage: no workbench page may exist before the recorder is in place.
	const before = (await cdp('Target.getTargets', {})).targetInfos;
	R.targetsAtStart = before.map((t) => `${t.type} ${t.url}`);
	if (before.some((t) => t.type === 'page' && WORKBENCH_URL.test(t.url))) {
		throw new Error('coverage: a workbench page existed before the observer attached; start the kit before entering QuantLab');
	}
	const urls = new Map(); const attached = new Map();
	for (const t of before) {
		urls.set(t.targetId, t.url);
	}
	handlers.set('Target.targetCreated', async (p) => { urls.set(p.targetInfo.targetId, p.targetInfo.url); });
	handlers.set('Target.targetInfoChanged', async (p) => { urls.set(p.targetInfo.targetId, p.targetInfo.url); });
	handlers.set('Target.attachedToTarget', async (p, parent) => {
		const sid = p.sessionId;
		if (p.targetInfo.type === 'page') {
			await cdp('Page.enable', {}, sid);
			await cdp('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }, sid);
			attached.set(p.targetInfo.targetId, sid);
		}
		if (p.waitingForDebugger) {
			await cdp('Runtime.runIfWaitingForDebugger', {}, sid);
		}
		R.attachLog.push(`${p.targetInfo.type} ${p.targetInfo.url} waiting=${p.waitingForDebugger} parentSession=${String(parent)}`);
	});
	await cdp('Target.setDiscoverTargets', { discover: true });
	await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	console.log('OBSERVER READY: enter QuantLab now');
	R.readyAt = new Date().toISOString();

	const wbTarget = await until('the workbench page (enter QuantLab)', 600000, () => {
		for (const [targetId, url] of urls) {
			if (WORKBENCH_URL.test(url)) {
				return targetId;
			}
		}
		return null;
	});
	if (!attached.has(wbTarget)) {
		throw new Error(`coverage: the workbench page ${urls.get(wbTarget)} was not attached at start, so the recorder is not in it`);
	}
	const sid = attached.get(wbTarget);
	const ev = async (expr) => {
		const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
		if (r.exceptionDetails) {
			throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
		}
		return r.result.value;
	};
	const installed = await until('the recorder in the workbench document', 30000, () => ev(`window.__qlChrome1 === undefined ? null : { installedAt: window.__qlChrome1.installedAt, workbenchAtInstall: window.__qlChrome1.workbenchAtInstall }`));
	R.recorder = installed;
	if (installed.workbenchAtInstall) {
		throw new Error('coverage: the workbench DOM existed when the recorder was installed');
	}
	const key = async (k, code, vk, modifiers) => {
		for (const type of ['rawKeyDown', 'keyUp']) {
			await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, sid);
		}
		await sleep(400);
	};
	const quickVisible = () => ev(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()`);

	await until('workbench editor part', 90000, () => ev(`!!document.querySelector('.monaco-workbench .part.editor')`));
	R.firstPaintShot = shot('first-paint');
	// Workspace trust (appears after first paint): answered YES, as in the STRIP rows (restricted mode can hide contributions).
	await sleep(3000);
	R.trust = await ev(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(x => /Yes, I trust/.test(x.textContent)); if (!b) { return 'no trust dialog'; } b.click(); return 'clicked: ' + b.textContent.trim(); })()`);
	await sleep(1500);

	// Startup completion: the Running Extensions editor shows Quantlab's activation time.
	await key('p', 'KeyP', 80, 4 | 8);
	await until('command palette', 5000, quickVisible);
	await cdp('Input.insertText', { text: 'Show Running Extensions' }, sid);
	await sleep(1200);
	const paletteRows = await ev(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.getAttribute('aria-label'))`);
	if (!paletteRows.some((l) => typeof l === 'string' && l.includes('Show Running Extensions'))) {
		throw new Error(`no "Show Running Extensions" command in the palette: ${JSON.stringify(paletteRows)}`);
	}
	await key('Enter', 'Enter', 13, 0);
	R.activation = await until('Quantlab activation time in Running Extensions', 120000, () => ev(`(() => {
		const row = [...document.querySelectorAll('.runtime-extensions-editor .extension')].find(e => { const n = e.querySelector('.name'); return n !== null && n.textContent.trim() === 'Quantlab'; });
		if (!row) { return null; } const t = row.querySelector('.activation-time'); if (t === null) { return null; }
		return /^(Startup )?Activation: \\d+ms$/.test(t.textContent.trim()) ? t.textContent.trim() : null; })()`));
	R.activationShot = shot('startup-complete');
	await sleep(5000);
	const S = await ev(`window.__qlChrome1`);
	R.history = S;

	R.rows.P2 = { toastElements: S.toastElements, toasts: S.toastTexts };
	const p2 = S.toastElements === 0;
	R.rows.P2.verdict = p2 ? 'GREEN' : 'RED';
	console.log(`ROW P2 ${R.rows.P2.verdict} ${S.toastElements} toast element(s) from document start to startup complete + 5 s ${JSON.stringify(S.toastTexts)}`);

	const currentTabs = await ev(`[...document.querySelectorAll('.tabs-container .tab')].map(e => e.getAttribute('aria-label'))`);
	if (currentTabs.some((l) => l === null)) {
		throw new Error(`DOM contract: an editor tab has no aria-label (${JSON.stringify(currentTabs)})`);
	}
	R.rows.P5 = { tabLabelsEverSeen: S.tabLabels, currentTabs };
	const p5 = !S.tabLabels.some((t) => /welcome/i.test(t));
	R.rows.P5.verdict = p5 ? 'GREEN' : 'RED';
	console.log(`ROW P5 ${R.rows.P5.verdict} tab labels ever seen ${JSON.stringify(S.tabLabels)}`);

	R.rows.P4 = await ev(`(() => { const wb = document.querySelector('.monaco-workbench'); const content = document.querySelector('.part.editor > .content');
		if (content === null) { return { contract: '.part.editor > .content is absent' }; }
		return { classes: wb.className, editorBgVar: getComputedStyle(wb).getPropertyValue('--vscode-editor-background').trim(), editorContentBg: getComputedStyle(content).backgroundColor }; })()`);
	if (R.rows.P4.contract !== undefined) {
		throw new Error(`DOM contract: ${R.rows.P4.contract}`);
	}
	R.rows.P4.shippedEditorBg = shippedEditorBg;
	const themeOk = /\bvscode-theme-defaults-themes-delta_plus_dark-json\b/.test(R.rows.P4.classes);
	const bgOk = R.rows.P4.editorBgVar.toLowerCase() === shippedEditorBg.toLowerCase() && R.rows.P4.editorContentBg === hexToRgb(shippedEditorBg);
	const p4 = themeOk && bgOk;
	R.rows.P4.verdict = p4 ? 'GREEN' : 'RED';
	console.log(`ROW P4 ${R.rows.P4.verdict} theme class ${themeOk ? 'delta_plus_dark' : 'ABSENT'}; --vscode-editor-background ${R.rows.P4.editorBgVar}, editor content ${R.rows.P4.editorContentBg}, shipped ${shippedEditorBg}`);

	// P1: open the python file by Quick Open, then read the right pane, the title-bar part and the editor toolbar.
	await key('p', 'KeyP', 80, 4);
	await until('quick open', 5000, quickVisible);
	await cdp('Input.insertText', { text: pyFile }, sid);
	await sleep(1200);
	await key('Enter', 'Enter', 13, 0);
	await until(`the active tab for ${pyFile}`, 15000, () => ev(`[...document.querySelectorAll('.tabs-container .tab.active')].some(e => { const l = e.getAttribute('aria-label'); return l !== null && l.includes(${JSON.stringify(pyFile)}); })`));
	await sleep(1500);
	R.rows.P1 = await ev(`(() => { const vis = (e) => e.offsetWidth > 0 && e.offsetHeight > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
		const aux = document.querySelector('.part.auxiliarybar'); const title = document.querySelector('.part.titlebar');
		const items = [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item')];
		const actions = items.map(i => { const a = i.querySelector('.action-label'); if (a === null) { return { contract: 'action item without .action-label' }; }
			return { label: a.getAttribute('aria-label'), visible: vis(a), disabled: i.classList.contains('disabled') || a.classList.contains('disabled') || a.getAttribute('aria-disabled') === 'true' }; });
		return { auxiliaryBarPresent: aux !== null, auxiliaryBarVisible: aux !== null && vis(aux), titleBarPartVisible: title !== null && vis(title), actions }; })()`);
	const broken = R.rows.P1.actions.filter((a) => a.contract !== undefined || a.label === null);
	if (broken.length) {
		throw new Error(`DOM contract: editor toolbar items without a labelled .action-label: ${JSON.stringify(R.rows.P1.actions)}`);
	}
	R.rows.P1.shot = shot('P1-python-file');
	const usable = (label) => R.rows.P1.actions.some((a) => a.label.startsWith(label) && a.visible && !a.disabled);
	const p1 = !R.rows.P1.auxiliaryBarVisible && !R.rows.P1.titleBarPartVisible && usable('Open as Action') && usable('Open as Chart');
	R.rows.P1.verdict = p1 ? 'GREEN' : 'RED';
	console.log(`ROW P1 ${R.rows.P1.verdict} aux visible ${R.rows.P1.auxiliaryBarVisible}, title part visible ${R.rows.P1.titleBarPartVisible}, toolbar ${JSON.stringify(R.rows.P1.actions)}`);

	sock.close();
	return p1 && p2 && p4 && p5 ? 0 : 1;
}

main().then((code) => { R.ended = new Date().toISOString(); save(); process.exit(code); }, (e) => fail(describe(e)));
