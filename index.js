// Extension Conflict Checker
// Statically scans extension source code (manifest, JS entry + relative imports, CSS, templates)
// and reports places where two extensions are likely to step on each other.

const MODULE = 'ext_conflict_checker';
const LOG = '[ConflictChecker]';
const MAX_FILES_PER_EXT = 40;
const MAX_BYTES_PER_EXT = 4_000_000;
const FETCH_CONCURRENCY = 6;

// Folder of this extension, so it can skip itself when scanning
const SELF_FOLDER = (() => {
    try {
        const m = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        return m ? decodeURIComponent(m[1]) : '';
    } catch {
        return '';
    }
})();

const defaultSettings = Object.freeze({
    includeDisabled: false,
    includeSystem: false,
    lastUrl: '',
});

// Keys in extension_settings that belong to ST core; writing them is normal, not a conflict
const CORE_SETTING_KEYS = new Set([
    'disabledExtensions', 'expressionOverrides', 'memory', 'note', 'caption', 'expressions',
    'connectionManager', 'dice', 'tts', 'sd', 'chromadb', 'translate', 'objective', 'quickReply',
    'quickReplyV2', 'randomizer', 'speech_recognition', 'rvc', 'gallery', 'cfg', 'variables',
    'attachments', 'character_attachments', 'disabled_attachments', 'regex', 'character_allowed_regex',
    'preset_allowed_regex', 'autoConnect', 'notifyUpdates', 'apiUrl', 'apiKey', 'vectors',
]);

// ---------------------------------------------------------------- settings

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

// ---------------------------------------------------------------- utils

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchText(url, init = {}) {
    const res = await fetch(url, { cache: 'no-store', ...init });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}

function cmpVersion(a, b) {
    const pa = String(a || '0').split(/[.-]/).map(x => parseInt(x) || 0);
    const pb = String(b || '0').split(/[.-]/).map(x => parseInt(x) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

function simpleHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function normRepo(url) {
    const m = String(url || '').match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
    return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}`.toLowerCase() : '';
}

// ---------------------------------------------------------------- source collection

/**
 * Collects manifest + source files of one extension.
 * @param {(rel: string) => string} resolveUrl maps a path relative to the extension root to a fetchable URL
 */
async function collectSources(resolveUrl, label) {
    const manifest = JSON.parse(await fetchText(resolveUrl('manifest.json')));
    const files = [];
    const seen = new Set();
    let bytes = 0;
    const queue = [];
    if (manifest.js) queue.push(manifest.js);
    if (manifest.css) queue.push(manifest.css);

    while (queue.length && files.length < MAX_FILES_PER_EXT && bytes < MAX_BYTES_PER_EXT) {
        const rel = queue.shift();
        if (seen.has(rel)) continue;
        seen.add(rel);
        let text;
        try {
            text = await fetchText(resolveUrl(rel));
        } catch (err) {
            console.debug(LOG, label, 'skip', rel, err.message);
            continue;
        }
        bytes += text.length;
        files.push({ path: rel, text });
        if (/\.(m?js|ts)$/i.test(rel)) {
            for (const dep of findLocalDeps(rel, text)) {
                if (!seen.has(dep)) queue.push(dep);
            }
        }
    }
    return { manifest, files };
}

// Relative imports and Handlebars templates referenced from a JS file
function findLocalDeps(fromRel, text) {
    const deps = new Set();
    const base = new URL(fromRel, 'https://x.invalid/root/');
    const add = (spec) => {
        if (!/^\.\.?\//.test(spec)) return;
        const u = new URL(spec, base);
        if (!u.pathname.startsWith('/root/')) return;
        let p = decodeURIComponent(u.pathname.slice('/root/'.length));
        if (!/\.[a-z]+$/i.test(p)) p += '.js';
        deps.add(p);
    };
    const reImport = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = reImport.exec(text))) add(m[1] || m[2] || m[3]);
    const reTpl = /renderExtensionTemplate(?:Async)?\(\s*[^,]+,\s*['"]([\w./-]+)['"]/g;
    while ((m = reTpl.exec(text))) {
        const name = m[1].endsWith('.html') ? m[1] : `${m[1]}.html`;
        deps.add(name.replace(/^\.\//, ''));
    }
    return [...deps];
}

// ---------------------------------------------------------------- fingerprint

function stripJsComments(text) {
    // Light comment removal; keeps strings intact well enough for regex scanning
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function collectConstants(text) {
    const map = new Map();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n$]{1,80})\2/g;
    let m;
    while ((m = re.exec(text))) map.set(m[1], m[3]);
    return map;
}

function resolveToken(token, consts) {
    const t = token.trim();
    const lit = t.match(/^(['"`])([^'"`]*)\1$/);
    if (lit) return lit[2];
    if (/^[A-Za-z_$][\w$]*$/.test(t) && consts.has(t)) return consts.get(t);
    return null;
}

/**
 * Builds a fingerprint of everything an extension registers or overrides globally.
 * Exported for testing.
 */
export function fingerprint(manifest, files, coreIds = new Set()) {
    const fp = {
        commands: new Set(), macros: new Set(), tools: new Set(), globals: new Set(),
        settingsKeys: new Set(), domIds: new Set(), patches: new Set(), firstLast: new Set(),
        hotkeys: new Set(), cssImportant: new Map(), events: new Set(),
        interceptor: manifest.generate_interceptor || '', hash: '',
    };
    const jsTexts = [];
    let hashSrc = '';

    for (const f of files) {
        hashSrc += f.text;
        if (/\.css$/i.test(f.path)) {
            scanCss(f.text, fp);
            continue;
        }
        if (/\.html?$/i.test(f.path)) {
            scanIds(f.text, fp, coreIds);
            continue;
        }
        jsTexts.push(stripJsComments(f.text));
    }
    fp.hash = simpleHash(hashSrc);

    for (const text of jsTexts) {
        const consts = collectConstants(text);
        let m;

        // Slash commands
        for (const re of [/registerSlashCommand\(\s*(['"`])([\w-]+)\1/g, /SlashCommandParser\.addCommand\(\s*(['"`])([\w-]+)\1/g]) {
            while ((m = re.exec(text))) fp.commands.add(m[2].toLowerCase());
        }
        const reFromProps = /SlashCommand\.fromProps\(\s*\{/g;
        while ((m = reFromProps.exec(text))) {
            const win = text.slice(m.index, m.index + 1500);
            const nm = win.match(/\bname\s*:\s*((['"`])[\w-]+\2|[A-Za-z_$][\w$]*)/);
            const name = nm ? resolveToken(nm[1], consts) : null;
            if (name) fp.commands.add(name.toLowerCase());
            const al = win.match(/\baliases\s*:\s*\[([^\]]*)\]/);
            if (al) for (const a of al[1].matchAll(/(['"`])([\w-]+)\1/g)) fp.commands.add(a[2].toLowerCase());
        }

        // Macros
        for (const re of [/macros\.register\(\s*(['"`])([\w.-]+)\1/g, /registerMacro\(\s*(['"`])([\w.-]+)\1/g, /registerAlias\(\s*(['"`])[\w.-]+\1\s*,\s*(['"`])([\w.-]+)\2/g]) {
            while ((m = re.exec(text))) fp.macros.add((m[3] || m[2]).toLowerCase());
        }

        // Function tools
        const reTool = /registerFunctionTool\(\s*\{/g;
        while ((m = reTool.exec(text))) {
            const nm = text.slice(m.index, m.index + 600).match(/\bname\s*:\s*((['"`])[\w-]+\2|[A-Za-z_$][\w$]*)/);
            const name = nm ? resolveToken(nm[1], consts) : null;
            if (name) fp.tools.add(name);
        }

        // Global assignments
        const reGlobal = /(?:globalThis|window|self)\.([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\|)?=(?!=)/g;
        while ((m = reGlobal.exec(text))) {
            if (m[1] === 'fetch') fp.patches.add('window.fetch');
            else fp.globals.add(m[1]);
        }
        const reGlobal2 = /(?:globalThis|window)\[\s*(['"`])([\w$]+)\1\s*\]\s*=(?!=)|Object\.defineProperty\(\s*(?:globalThis|window)\s*,\s*(['"`])([\w$]+)\3/g;
        while ((m = reGlobal2.exec(text))) fp.globals.add(m[2] || m[4]);

        // extension_settings keys that this extension writes
        const reSet = /(?:extension_settings|extensionSettings)(?:\[\s*([^\]\n]+?)\s*\]|\.([A-Za-z_$][\w$]*))\s*(?:\?\?|\|\|)?=(?!=)/g;
        while ((m = reSet.exec(text))) {
            const key = m[2] || resolveToken(m[1], consts);
            if (key && !CORE_SETTING_KEYS.has(key)) fp.settingsKeys.add(key);
        }

        // DOM ids the extension creates
        scanIds(text, fp, coreIds);

        // Monkey patches of shared objects
        const rePatch = [
            [/XMLHttpRequest\.prototype\.([\w$]+)\s*=(?!=)/g, x => `XMLHttpRequest.prototype.${x[1]}`],
            [/(?:\$|jQuery)\.fn\.([\w$]+)\s*=(?!=)/g, x => `$.fn.${x[1]}`],
            [/\b(eventSource|toastr|console|history|SillyTavern|Popup)\.([\w$]+)\s*=(?!=)/g, x => `${x[1]}.${x[2]}`],
            [/\b(Element|HTMLElement|Node|Array|String|Object|Function|EventTarget|Promise)\.prototype\.([\w$]+)\s*=(?!=)/g, x => `${x[1]}.prototype.${x[2]}`],
            [/\bdocument\.(title|onkeydown|onkeyup|onclick|onpaste)\s*=(?!=)/g, x => `document.${x[1]}`],
        ];
        for (const [re, fmt] of rePatch) {
            while ((m = re.exec(text))) fp.patches.add(fmt(m));
        }

        // Events and ordering hooks
        const reEv = /eventSource\.(on|once|makeFirst|makeLast)\(\s*(?:(?:event_types|eventTypes|tavern_events)\.([A-Z_]+)|(['"`])([\w-]+)\3)/g;
        while ((m = reEv.exec(text))) {
            const ev = m[2] || m[4];
            fp.events.add(ev);
            if (m[1] === 'makeFirst' || m[1] === 'makeLast') fp.firstLast.add(`${m[1]}:${ev}`);
        }

        // Hotkeys (heuristic: key literal close to a modifier check, in a file that listens to keydown)
        if (/['"`]keydown['"`]/.test(text)) {
            const reKey = /\.(key|code)\s*===?\s*(['"`])([\w ]{1,15})\2/g;
            while ((m = reKey.exec(text))) {
                const around = text.slice(Math.max(0, m.index - 160), m.index + 160);
                const mods = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].filter(k => around.includes(k)).map(k => k.replace('Key', ''));
                if (mods.length) fp.hotkeys.add(`${mods.sort().join('+')}+${m[3].replace(/^Key/, '')}`.toLowerCase());
            }
        }
    }
    return fp;
}

function scanIds(text, fp, coreIds) {
    let m;
    const reId = /\bid\s*=\s*\\?(['"])([A-Za-z][\w-]{2,})\\?\1|\.id\s*=\s*(['"`])([A-Za-z][\w-]{2,})\3|setAttribute\(\s*['"]id['"]\s*,\s*(['"`])([A-Za-z][\w-]{2,})\5/g;
    while ((m = reId.exec(text))) {
        const id = m[2] || m[4] || m[6];
        if (id && !coreIds.has(id)) fp.domIds.add(id);
    }
}

function scanCss(text, fp) {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
        const body = m[2];
        if (!body.includes('!important')) continue;
        const props = [...body.matchAll(/([\w-]+)\s*:[^;]*!important/g)].map(x => x[1].toLowerCase());
        if (!props.length) continue;
        for (const rawSel of m[1].split(',')) {
            const sel = rawSel.replace(/@[^;{]*$/, '').replace(/\s+/g, ' ').trim();
            if (!sel || sel.startsWith('@') || /^(from|to|\d+%)$/.test(sel)) continue;
            if (!fp.cssImportant.has(sel)) fp.cssImportant.set(sel, new Set());
            props.forEach(p => fp.cssImportant.get(sel).add(p));
        }
    }
}

// ---------------------------------------------------------------- comparison

const SEV = { danger: 3, caution: 2, info: 1 };

function intersect(a, b) {
    return [...a].filter(x => b.has(x));
}

/**
 * Compares two fingerprinted extensions and returns findings.
 * Exported for testing.
 */
export function compare(A, B) {
    const out = [];
    const push = (sev, title, items, hint) => {
        if (items.length) out.push({ sev, title, items, hint, a: A.label, b: B.label });
    };
    const fa = A.fp;
    const fb = B.fp;

    if (fa.hash && fa.hash === fb.hash) {
        push('danger', '같은 확장이 두 번 설치된 것 같아요', ['소스 코드가 완전히 같음'], '하나를 지우세요. 명령·설정이 전부 겹칩니다.');
    }
    push('danger', '같은 슬래시 명령', intersect(fa.commands, fb.commands).map(x => `/${x}`), '나중에 로드된 쪽이 앞의 명령을 덮어씁니다.');
    push('danger', '같은 매크로', intersect(fa.macros, fb.macros).map(x => `{{${x}}}`), '한쪽 매크로가 다른 쪽을 덮어씁니다.');
    push('danger', '같은 함수 도구(Function tool) 이름', intersect(fa.tools, fb.tools), 'AI가 호출할 때 한쪽만 동작합니다.');
    if (fa.interceptor && fa.interceptor === fb.interceptor) {
        push('danger', '같은 생성 인터셉터 함수 이름', [fa.interceptor], '전역 함수가 덮어써져 한쪽 인터셉터가 두 번 돌고 다른 쪽은 안 돕니다.');
    } else if (fa.interceptor && fb.interceptor) {
        push('info', '둘 다 프롬프트를 가로채서 수정함', [`${fa.interceptor} / ${fb.interceptor}`], 'loading_order 순서대로 실행됩니다. 결과가 이상하면 순서를 확인하세요.');
    }
    push('danger', '같은 전역 변수(window.*)에 대입', intersect(fa.globals, fb.globals).map(x => `window.${x}`), '나중에 로드된 쪽 값만 남습니다.');
    push('danger', '같은 extension_settings 키에 저장', intersect(fa.settingsKeys, fb.settingsKeys), '서로의 설정을 덮어써서 설정이 초기화되거나 꼬일 수 있어요.');
    push('danger', '같은 HTML id 생성', intersect(fa.domIds, fb.domIds).map(x => `#${x}`), 'getElementById가 엉뚱한 요소를 잡아 UI가 깨질 수 있어요.');
    push('caution', '같은 대상을 몽키패치(덮어쓰기)', intersect(fa.patches, fb.patches), '둘이 원래 함수를 각자 감싸면 순서에 따라 한쪽 기능이 사라질 수 있어요.');
    push('caution', '같은 단축키', intersect(fa.hotkeys, fb.hotkeys), '키를 누르면 두 동작이 동시에 일어날 수 있어요.');
    push('caution', '같은 이벤트에서 둘 다 "맨 앞/맨 뒤"를 요구', intersect(fa.firstLast, fb.firstLast), '둘 다 먼저(또는 나중에) 실행되려 해서 순서가 보장되지 않아요.');

    const css = [];
    for (const [sel, props] of fa.cssImportant) {
        const other = fb.cssImportant.get(sel);
        if (!other) continue;
        const both = intersect(props, other);
        if (both.length) css.push(`${sel} { ${both.join(', ')} }`);
    }
    push('caution', 'CSS !important 가 같은 곳에 겹침', css, '나중에 로드된 스타일이 이깁니다. 화면이 의도와 다르게 보일 수 있어요.');

    const sharedEvents = intersect(fa.events, fb.events);
    if (sharedEvents.length >= 4) {
        push('info', '같은 이벤트를 많이 구독', sharedEvents, '대부분 문제 없지만, 둘 다 메시지 내용을 수정한다면 결과가 섞일 수 있어요.');
    }
    return out;
}

function checkTargetAlone(target, installed, stVersion) {
    const out = [];
    const m = target.manifest;
    const push = (sev, title, items, hint) => out.push({ sev, title, items, hint, a: target.label, b: '' });

    if (m.minimum_client_version && stVersion && cmpVersion(stVersion, m.minimum_client_version) < 0) {
        push('danger', 'SillyTavern 버전이 낮음', [`필요: ${m.minimum_client_version} / 현재: ${stVersion}`], 'ST를 업데이트하지 않으면 동작하지 않을 수 있어요.');
    }
    for (const dep of m.dependencies || []) {
        const found = installed.find(e => e.name === dep || e.name.endsWith(`/${dep}`));
        if (!found) push('danger', '필요한 확장이 없음', [dep], '이 확장을 먼저 설치해야 합니다.');
        else if (!found.enabled) push('caution', '필요한 확장이 꺼져 있음', [dep], '확장 목록에서 켜 주세요.');
    }
    const repo = normRepo(target.source);
    for (const e of installed) {
        const sameRepo = repo && (normRepo(e.manifest.homePage) === repo || e.name.toLowerCase().endsWith(`/${repo.split('/')[1]}`));
        const sameName = e.manifest.display_name && e.manifest.display_name === m.display_name;
        if (sameRepo || sameName) {
            const v = cmpVersion(m.version, e.manifest.version);
            const vt = v > 0 ? '링크 쪽이 더 최신' : v < 0 ? '설치된 쪽이 더 최신' : '같은 버전';
            push('info', '이미 설치된 확장과 같은 것', [`${e.manifest.display_name || e.name} (설치: ${e.manifest.version || '?'} / 링크: ${m.version || '?'} → ${vt})`], '새로 설치하지 말고 업데이트하세요.');
        }
    }
    const risky = [...target.fp.patches].filter(p => /fetch|XMLHttpRequest|eventSource|prototype/.test(p));
    if (risky.length) push('info', '이 확장은 ST 핵심 동작을 덮어씀', risky, '혼자서는 괜찮지만 비슷한 일을 하는 확장과 함께 쓰면 문제 날 수 있어요.');
    return out;
}

// ---------------------------------------------------------------- inventory

let installedCache = null;
let coreIdsCache = null;

async function getCoreIds() {
    if (coreIdsCache) return coreIdsCache;
    try {
        const html = await fetchText('/');
        coreIdsCache = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]));
    } catch {
        coreIdsCache = new Set();
    }
    return coreIdsCache;
}

async function getStVersion() {
    try {
        const r = await fetch('/version', { cache: 'no-store' });
        const j = await r.json();
        return j.pkgVersion || '';
    } catch {
        return '';
    }
}

async function loadInstalled(force = false) {
    if (installedCache && !force) return installedCache;
    const { getRequestHeaders, extensionSettings } = SillyTavern.getContext();
    const res = await fetch('/api/extensions/discover', { headers: getRequestHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`확장 목록을 불러오지 못했어요 (HTTP ${res.status})`);
    const list = await res.json();
    const disabled = new Set(extensionSettings.disabledExtensions || []);
    const coreIds = await getCoreIds();

    const entries = list.filter(e => e.name !== SELF_FOLDER);
    const loaded = await mapLimit(entries, FETCH_CONCURRENCY, async (e) => {
        try {
            const base = `/scripts/extensions/${e.name.split('/').map(encodeURIComponent).join('/')}/`;
            const { manifest, files } = await collectSources(rel => base + rel.split('/').map(encodeURIComponent).join('/'), e.name);
            return {
                name: e.name, type: e.type, enabled: !disabled.has(e.name), manifest,
                label: manifest.display_name || e.name.replace(/^third-party\//, ''),
                fp: fingerprint(manifest, files, coreIds),
            };
        } catch (err) {
            console.warn(LOG, 'failed to scan', e.name, err);
            return null;
        }
    });
    installedCache = loaded.filter(Boolean);
    return installedCache;
}

function filterInstalled(list) {
    const s = getSettings();
    return list.filter(e => (s.includeSystem || e.type !== 'system') && (s.includeDisabled || e.enabled));
}

// ---------------------------------------------------------------- remote (link)

/**
 * Turns a GitHub (or any) link into a resolver for files in the extension root.
 * Exported for testing.
 */
export function parseRepoLink(input) {
    const url = String(input || '').trim();
    let m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?(?:[#?].*)?$/i);
    if (m) return { kind: 'github', owner: m[1], repo: m[2], branch: m[3] || '', sub: (m[4] || '').replace(/\/?manifest\.json$/i, '') };
    m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/?(.*?)\/?(?:manifest\.json)?$/i);
    if (m) return { kind: 'github', owner: m[1], repo: m[2], branch: m[3], sub: m[4] || '' };
    if (/^https?:\/\//i.test(url)) return { kind: 'url', base: url.replace(/manifest\.json$/i, '').replace(/\/?$/, '/') };
    return null;
}

async function loadRemote(link) {
    const info = parseRepoLink(link);
    if (!info) throw new Error('링크 형식을 알 수 없어요. GitHub 저장소 주소를 넣어 주세요.');
    let resolver;
    if (info.kind === 'github') {
        const branches = [];
        if (info.branch) branches.push(info.branch);
        else {
            try {
                const meta = await (await fetch(`https://api.github.com/repos/${info.owner}/${info.repo}`)).json();
                if (meta.default_branch) branches.push(meta.default_branch);
            } catch { /* rate limit or offline: fall back */ }
            branches.push('main', 'master');
        }
        const sub = info.sub ? `${info.sub.replace(/\/$/, '')}/` : '';
        for (const br of [...new Set(branches)]) {
            const base = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${encodeURIComponent(br)}/${sub}`;
            const r = await fetch(`${base}manifest.json`, { cache: 'no-store' }).catch(() => null);
            if (r?.ok) { resolver = rel => base + rel; break; }
        }
        if (!resolver) throw new Error('manifest.json을 찾지 못했어요. 저장소 주소나 브랜치를 확인해 주세요.');
    } else {
        resolver = rel => new URL(rel, info.base).href;
    }
    const { manifest, files } = await collectSources(resolver, link);
    return {
        name: link, enabled: true, manifest, source: link,
        label: manifest.display_name || (info.repo ?? link),
        fp: fingerprint(manifest, files, await getCoreIds()),
    };
}

// ---------------------------------------------------------------- report UI

function summarizeFp(fp) {
    const parts = [];
    if (fp.commands.size) parts.push(`명령 ${fp.commands.size}`);
    if (fp.macros.size) parts.push(`매크로 ${fp.macros.size}`);
    if (fp.globals.size) parts.push(`전역 ${fp.globals.size}`);
    if (fp.settingsKeys.size) parts.push(`설정키 ${fp.settingsKeys.size}`);
    if (fp.domIds.size) parts.push(`id ${fp.domIds.size}`);
    if (fp.patches.size) parts.push(`패치 ${fp.patches.size}`);
    if (fp.cssImportant.size) parts.push(`CSS ${fp.cssImportant.size}`);
    return parts.join(' · ') || '등록 항목 없음';
}

function renderReport(title, findings, scanned, extra = '') {
    findings.sort((x, y) => SEV[y.sev] - SEV[x.sev]);
    const count = s => findings.filter(f => f.sev === s).length;
    const sevLabel = { danger: '충돌 위험', caution: '주의', info: '참고' };

    const rows = findings.map(f => `
        <div class="ecc-item ecc-${f.sev}">
            <div class="ecc-item-head">
                <span class="ecc-badge">${sevLabel[f.sev]}</span>
                <b>${esc(f.title)}</b>
            </div>
            <div class="ecc-pair">${esc(f.a)}${f.b ? ` <i class="fa-solid fa-arrows-left-right"></i> ${esc(f.b)}` : ''}</div>
            <ul>${f.items.slice(0, 12).map(i => `<li><code>${esc(i)}</code></li>`).join('')}${f.items.length > 12 ? `<li>…외 ${f.items.length - 12}개</li>` : ''}</ul>
            <div class="ecc-hint">${esc(f.hint)}</div>
        </div>`).join('');

    const verdict = count('danger')
        ? `<div class="ecc-verdict ecc-danger">충돌 위험 ${count('danger')}건이 있어요</div>`
        : count('caution')
            ? `<div class="ecc-verdict ecc-caution">큰 충돌은 없지만 주의할 점 ${count('caution')}건</div>`
            : '<div class="ecc-verdict ecc-ok">충돌 신호가 없어요</div>';

    return `
    <div class="ecc-report">
        <h3>${esc(title)}</h3>
        ${verdict}
        <div class="ecc-counts">위험 ${count('danger')} · 주의 ${count('caution')} · 참고 ${count('info')} · 검사한 확장 ${scanned.length}개</div>
        ${extra}
        ${rows || ''}
        <details class="ecc-scanned"><summary>검사한 확장 목록</summary>
            <ul>${scanned.map(e => `<li><b>${esc(e.label)}</b> <small>${esc(e.manifest.version || '')}${e.enabled === false ? ' (꺼짐)' : ''}</small><br><small>${esc(summarizeFp(e.fp))}</small></li>`).join('')}</ul>
        </details>
        <div class="ecc-note">코드를 정적으로 읽어서 찾은 "가능성"이에요. 압축(번들)된 확장은 일부 항목을 못 찾을 수 있고, 표시돼도 실제로는 문제없을 수 있어요.</div>
    </div>`;
}

async function showReport(html) {
    const { Popup, POPUP_TYPE } = SillyTavern.getContext();
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

// ---------------------------------------------------------------- actions

async function withLoader(message, fn) {
    const { loader } = SillyTavern.getContext();
    const handle = loader?.show ? loader.show({ message, blocking: false }) : null;
    try {
        return await fn();
    } finally {
        await handle?.hide?.();
    }
}

async function checkLink(link, { silent = false } = {}) {
    if (!link) {
        toastr.warning('검사할 확장의 GitHub 링크를 넣어 주세요.');
        return '';
    }
    try {
        return await withLoader('확장 코드를 읽는 중…', async () => {
            const [target, installedAll, stVersion] = await Promise.all([loadRemote(link), loadInstalled(true), getStVersion()]);
            const installed = filterInstalled(installedAll);
            const findings = [...checkTargetAlone(target, installedAll, stVersion)];
            // Skip comparing with the same extension already installed (that is an update, not a conflict)
            const repo = normRepo(link);
            for (const e of installed) {
                const same = (repo && normRepo(e.manifest.homePage) === repo)
                    || (repo && e.name.toLowerCase().endsWith(`/${repo.split('/')[1]}`))
                    || (e.manifest.display_name && e.manifest.display_name === target.manifest.display_name);
                if (same) continue;
                findings.push(...compare(target, e));
            }
            const extra = `<div class="ecc-target">대상: <b>${esc(target.label)}</b> ${esc(target.manifest.version || '')}<br><small>${esc(summarizeFp(target.fp))}</small></div>`;
            const html = renderReport('새 확장 ↔ 설치된 확장 비교', findings, [target, ...installed], extra);
            if (!silent) await showReport(html);
            return summaryText(findings);
        });
    } catch (err) {
        console.error(LOG, err);
        toastr.error(err.message || String(err), '충돌 검사 실패');
        return `error: ${err.message}`;
    }
}

async function checkInstalled({ silent = false } = {}) {
    try {
        return await withLoader('설치된 확장을 읽는 중…', async () => {
            const installed = filterInstalled(await loadInstalled(true));
            const findings = [];
            for (let i = 0; i < installed.length; i++) {
                for (let j = i + 1; j < installed.length; j++) {
                    findings.push(...compare(installed[i], installed[j]));
                }
            }
            const html = renderReport('설치된 확장끼리 충돌 검사', findings, installed);
            if (!silent) await showReport(html);
            return summaryText(findings);
        });
    } catch (err) {
        console.error(LOG, err);
        toastr.error(err.message || String(err), '충돌 검사 실패');
        return `error: ${err.message}`;
    }
}

function summaryText(findings) {
    const c = s => findings.filter(f => f.sev === s).length;
    return `danger=${c('danger')} caution=${c('caution')} info=${c('info')}`;
}

// ---------------------------------------------------------------- settings panel

function createSettingsUI() {
    const s = getSettings();
    const html = `
    <div id="ecc_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>확장 충돌 검사기</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="ecc_url">설치하려는 확장의 GitHub 링크</label>
                <div class="flex-container">
                    <input id="ecc_url" class="text_pole flex1" type="text" placeholder="https://github.com/작성자/확장이름" />
                    <div id="ecc_check_link" class="menu_button menu_button_icon"><i class="fa-solid fa-magnifying-glass"></i><span>링크 검사</span></div>
                </div>
                <div id="ecc_check_installed" class="menu_button menu_button_icon"><i class="fa-solid fa-puzzle-piece"></i><span>설치된 확장 전체 검사</span></div>
                <label class="checkbox_label"><input id="ecc_include_disabled" type="checkbox" /><span>꺼진 확장도 포함</span></label>
                <label class="checkbox_label"><input id="ecc_include_system" type="checkbox" /><span>ST 기본 내장 확장도 포함</span></label>
                <small>슬래시 명령: <code>/extconflict</code> (전체 검사), <code>/extconflict 링크</code> (링크 비교)</small>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const { saveSettingsDebounced } = SillyTavern.getContext();
    const url = document.getElementById('ecc_url');
    url.value = s.lastUrl || '';
    url.addEventListener('change', () => { s.lastUrl = url.value.trim(); saveSettingsDebounced(); });

    for (const [id, key] of [['ecc_include_disabled', 'includeDisabled'], ['ecc_include_system', 'includeSystem']]) {
        const el = document.getElementById(id);
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; saveSettingsDebounced(); });
    }
    document.getElementById('ecc_check_link').addEventListener('click', () => {
        s.lastUrl = url.value.trim();
        saveSettingsDebounced();
        checkLink(s.lastUrl);
    });
    document.getElementById('ecc_check_installed').addEventListener('click', () => checkInstalled());
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'extconflict',
        callback: async (_named, unnamed) => {
            const link = String(unnamed ?? '').trim();
            return link ? await checkLink(link) : await checkInstalled();
        },
        returns: 'danger/caution/info counts',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'GitHub link of the extension to compare (empty = check installed extensions against each other)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: '<div>확장 충돌 검사. <code>/extconflict</code> 설치된 확장끼리, <code>/extconflict https://github.com/…</code> 새 확장과 비교.</div>',
    }));
}

// ---------------------------------------------------------------- init

if (globalThis.SillyTavern?.getContext) {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => {
        try {
            getSettings();
            createSettingsUI();
            registerCommand();
            console.log(LOG, 'ready', SELF_FOLDER);
        } catch (err) {
            console.error(LOG, 'init failed', err);
        }
    });
}
