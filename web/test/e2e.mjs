// Browser tests against the real server: node web/test/e2e.mjs <startpage binary>
// Starts the server and a headless Chrome on free ports with throwaway data and profile.
// CHROME selects the browser binary. All bookmarks point to 127.0.0.1:9, so no request leaves the machine.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const binary = process.argv[2];
if (!binary) { console.error('usage: node web/test/e2e.mjs <startpage binary>'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'startpage-e2e-'));
const procs = [];
let failed = 0;

function check(name, cond, detail) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failed++;
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const d of (process.env.PATH || '').split(delimiter)) {
    for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  }
  const win = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (existsSync(win)) return win;
  throw new Error('no Chrome or Chromium found; set CHROME');
}

async function waitUntil(fn, ms, what) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error('timeout: ' + what);
}

async function startServer() {
  writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify({ version: 1, categories: [{ id: 'c1', name: 'Tools', order: 0, bookmarks: [
    { id: 'b1', title: 'Jira', url: 'http://127.0.0.1:9/jira', description: 'Team tickets', tags: ['ticket'], order: 0 },
    { id: 'b2', title: 'Wiki', url: 'http://127.0.0.1:9/wiki', tags: [], order: 1 }] }] }));
  const p = spawn(binary, ['-addr', '127.0.0.1:0', '-data', join(dir, 'bookmarks.json')], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(p);
  let log = '';
  p.stderr.on('data', d => { log += d; });
  const port = await waitUntil(async () => (/localhost:(\d+)/.exec(log) || [])[1], 10000, 'server start');
  return 'http://localhost:' + port;
}

async function startChrome() {
  const profile = join(dir, 'profile');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--window-size=1100,800', 'about:blank'];
  if (process.env.CI) args.unshift('--no-sandbox');
  procs.push(spawn(findChrome(), args, { stdio: 'ignore' }));
  const port = await waitUntil(async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], 20000, 'chrome start');
  const targets = await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), 10000, 'devtools');
  return targets.find(t => t.type === 'page').webSocketDebuggerUrl;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const navigations = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Page.frameRequestedNavigation') navigations.push(d.params.url);
  };
  const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise(r => { ws.onopen = () => r({ ws, cdp, navigations }); });
}

async function run() {
  const base = await startServer();
  const { ws, cdp, navigations } = await connect(await startChrome());
  const ev = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  const waitFor = (expr, ms = 5000) => waitUntil(() => ev(expr), ms, expr);
  const open = async path => { await cdp('Page.navigate', { url: base + path }); };
  const bookmarks = async () => (await (await fetch(base + '/api/bookmarks')).json()).categories.flatMap(c => c.bookmarks);
  const ctrlZ = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
    }
  };
  const clickOk = () => ev(`document.querySelector('dialog .btn.default').click()`);
  const settle = () => sleep(500);
  await cdp('Page.enable');

  await open('/');
  await waitFor(`document.querySelector('.tile')`);
  check('page offers the OpenSearch description', await ev(`!!document.querySelector('link[rel=search][href="/opensearch.xml"]')`));

  check('only bookmarks with a description carry the mark',
    await ev(`!!document.querySelector('.tile[data-bm-id="b1"] .desc-mark') && !document.querySelector('.tile[data-bm-id="b2"] .desc-mark')`));
  check('tiles without a description show only their title', await ev(`document.querySelector('.tile[data-bm-id="b2"] .tile-link').textContent.trim().endsWith('Wiki')`));
  check('bookmark links have no native tooltip', await ev(`!document.querySelector('.tile-link[title]')`));
  const tileCenter = await ev(`(() => { const r = document.querySelector('.tile[data-bm-id="b1"] .tile-title').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const hover = ([x, y]) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const tipText = `(() => { const t = document.querySelector('.tooltip'); return t && !t.hidden ? t.textContent : ''; })()`;
  await hover(tileCenter);
  await sleep(500);
  check('the tooltip waits while the pointer rests', (await ev(tipText)) === '');
  await sleep(900);
  const shown = await ev(tipText);
  check('the tooltip shows title, URL and description after the delay', shown.includes('Jira') && shown.includes('/jira') && shown.includes('Team tickets'), shown);
  await hover([5, 5]);
  check('the tooltip hides when the pointer leaves', (await ev(tipText)) === '');
  const plainCenter = await ev(`(() => { const r = document.querySelector('.tile[data-bm-id="b2"] .tile-title').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await hover(plainCenter);
  await sleep(1400);
  const plain = await ev(`(() => { const t = document.querySelector('.tooltip'); return t && !t.hidden ? [t.children.length, t.textContent] : null; })()`);
  check('a tooltip without description shows only title and URL', !!plain && plain[0] === 2 && !plain[1].includes('null'), JSON.stringify(plain));
  await hover([5, 5]);
  await ev(`document.querySelector('#btn-edit').click()`);
  await hover(tileCenter);
  await sleep(1400);
  check('edit mode shows no tooltip', (await ev(tipText)) === '');
  await ev(`document.querySelector('#btn-edit').click()`);
  await hover([5, 5]);

  await open('/?add=' + encodeURIComponent('http://127.0.0.1:9/new') + '&title=' + encodeURIComponent('New Page'));
  await waitFor(`document.querySelector('dialog[open]')`);
  const fields = await ev(`[...document.querySelectorAll('dialog input')].map(i => i.value)`);
  check('?add prefills title and URL', fields[0] === 'New Page' && fields[1] === 'http://127.0.0.1:9/new', JSON.stringify(fields));
  check('?add is removed from the address', await ev(`location.search === ''`));
  check('?add saves nothing before OK', (await bookmarks()).length === 2);
  await ev(`document.querySelector('dialog textarea').value = '  First line \\n second line '`);
  await clickOk();
  await waitFor(`!document.querySelector('dialog[open]')`);
  await settle();
  const added = (await bookmarks()).find(b => b.title === 'New Page');
  check('?add saves after OK', !!added);
  check('the dialog saves the trimmed description', added && added.description === 'First line\nsecond line', JSON.stringify(added));

  await open('/?add=' + encodeURIComponent('http://127.0.0.1:9/jira/') + '&title=Dup');
  await waitFor(`document.querySelector('dialog[open]')`);
  await clickOk();
  await sleep(200);
  const warning = await ev(`document.querySelector('.dlg-error').textContent`);
  check('duplicate URL shows a warning', /already saved as “Jira” in “Tools”/.test(warning), warning);
  await clickOk();
  await waitFor(`!document.querySelector('dialog[open]')`);
  await settle();
  check('second OK saves the duplicate', (await bookmarks()).some(b => b.title === 'Dup'));
  check('the change offers Undo', await ev(`[...document.querySelectorAll('.toast-action')].some(b => b.textContent === 'Undo')`));

  await ev(`document.querySelector('#search').focus()`);
  await ctrlZ();
  await settle();
  check('Ctrl+Z undoes the last change', !(await bookmarks()).some(b => b.title === 'Dup'));
  await ctrlZ();
  await sleep(300);
  check('a second Ctrl+Z has nothing to undo', await ev(`[...document.querySelectorAll('.toast-body')].some(t => t.textContent.includes('Nothing to undo'))`));

  await ev(`document.querySelector('.tile[data-bm-id="b2"] a').click()`);
  await settle();
  const wiki = (await bookmarks()).find(b => b.id === 'b2');
  check('a click counts a visit', wiki.visits === 1 && wiki.lastVisit > 0, JSON.stringify(wiki));

  await open('/');
  await waitFor(`document.querySelector('.tile')`);
  await ev(`(() => { const i = document.querySelector('#search'); i.value = '127'; i.dispatchEvent(new Event('input')); })()`);
  const order = await ev(`[...document.querySelectorAll('.result .r-title')].map(e => e.firstChild.textContent)`);
  check('the visited bookmark ranks first among equal matches', order[0] === 'Wiki', JSON.stringify(order));

  const html = join(dir, 'import.html');
  writeFileSync(html, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Docs</H3><DD>Folder note<DL><p>' +
    '<DT><A HREF="http://127.0.0.1:9/manual" TAGS="ref">Manual</A>\n<DD>How to &amp; why\n' +
    '<DT><A HREF="javascript:alert(1)">Bad</A></DL><p></DL>');
  const doc = await cdp('DOM.getDocument');
  const input = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file-input' });
  await cdp('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [html] });
  await waitFor(`document.querySelector('dialog[open]')`);
  check('import counts the skipped unsafe link', /1 skipped/.test(await ev(`document.querySelector('dialog').textContent`)));
  await clickOk();
  await waitFor(`!document.querySelector('dialog[open]')`);
  await settle();
  const manual = (await bookmarks()).find(b => b.title === 'Manual');
  check('browser bookmark HTML is imported with tags', !!manual && manual.tags[0] === 'ref', JSON.stringify(manual));
  check('browser bookmark HTML is imported with descriptions', !!manual && manual.description === 'How to & why', JSON.stringify(manual));
  const docsCat = (await (await fetch(base + '/api/bookmarks')).json()).categories.find(c => c.bookmarks.some(b => b.title === 'Manual'));
  check('a folder description keeps the folder name', docsCat && docsCat.name === 'Docs', docsCat && docsCat.name);

  navigations.length = 0;
  await open('/?q=jira');
  await sleep(2500);
  check('?q with a strong match opens the bookmark', navigations.some(u => u.startsWith('http://127.0.0.1:9/jira')), JSON.stringify(navigations));
  check('?q counts the visit', (await bookmarks()).find(b => b.id === 'b1').visits === 1);

  await open('/?q=jra');
  await waitFor(`document.querySelector('.result')`);
  check('?q with only fuzzy matches shows the results', await ev(`location.search === '' && document.querySelector('#search').value === 'jra'`));

  ws.close();
}

try {
  await run();
} catch (e) {
  console.log('FAIL ' + e.message);
  failed++;
} finally {
  for (const p of procs) p.kill();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
