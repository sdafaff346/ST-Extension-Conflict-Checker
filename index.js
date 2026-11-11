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
    aiProfileId: '',
    aiUsePreset: false,
    aiPrompt: '',
    aiMaxTokens: 8000,
    aiConsent: false,
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
    // v1.2 default was too small for thinking models
    if (extensionSettings[MODULE].aiMaxTokens === 3000) extensionSettings[MODULE].aiMaxTokens = 8000;
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

/**
 * Light comment removal for readable source. Bundled/minified files are left untouched:
 * there "//" and "/*" appear inside strings and regexes on one huge line, and stripping
 * would delete most of the code. Exported for testing.
 */
export function stripJsComments(text) {
    if (isMinified(text)) return text;
    return text
        .split('\n')
        .map(line => (/^\s*\/\//.test(line) ? '' : line.replace(/(^|[\s;{}),])\/\/\s[^'"`]*$/, '$1')))
        .join('\n')
        .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, ' ');
}

function isMinified(text) {
    const lines = text.split('\n');
    const long = lines.filter(l => l.length > 400).length;
    return long > 0 && (long / lines.length > 0.05 || text.length / lines.length > 300);
}

// Globals that bundles routinely set for libraries or iframes; sharing them is not a conflict
const IGNORED_GLOBALS = new Set([
    '$', 'jQuery', '_', 'name', 'onload', 'onerror', 'onmessage', 'location', 'regeneratorRuntime', 'Vue', 'React', 'ReactDOM',
    'YAML', 'Buffer', 'process', 'global', 'module', 'exports', 'define', 'require', 'Popper', 'DOMPurify', 'moment', 'hljs',
    'showdown', 'toastr', 'lodash', 'Fuse', 'localforage', 'Handlebars', 'Readability', 'SillyTavern', '__VUE_OPTIONS_API__',
    '__VUE_PROD_DEVTOOLS__', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__', 'MonacoEnvironment', 'webpackJsonp', 'dataLayer',
    'parent', 'top', 'self', 'opener', 'frames', 'window', 'document', 'console',
]);

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
        // Works for readable and bundled code (where SlashCommand is renamed, e.g. "Qt.fromProps({name:`x`,callback:...")
        const reFromProps = /(?:SlashCommand\.fromProps|addCommandObject\(\s*(?:new\s+)?[\w$.]+(?:\.fromProps)?)\(\s*\{/g;
        while ((m = reFromProps.exec(text))) {
            const win = text.slice(m.index, m.index + 1500);
            // Argument definitions also use fromProps({name:...}); a command has a callback
            if (!/\bcallback\s*:/.test(win.slice(0, 900))) continue;
            const nm = win.match(/\{\s*(?:[\w$]+\s*:[^,]{0,80},\s*)?name\s*:\s*((['"`])[\w-]+\2|[A-Za-z_$][\w$]*)/) || win.match(/\bname\s*:\s*((['"`])[\w-]+\2|[A-Za-z_$][\w$]*)/);
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
            else if (!IGNORED_GLOBALS.has(m[1]) && m[1].length > 2 && !m[1].startsWith('webpackChunk')) fp.globals.add(m[1]);
        }
        const reGlobal2 = /(?:globalThis|window)\[\s*(['"`])([\w$]+)\1\s*\]\s*=(?!=)|Object\.defineProperty\(\s*(?:globalThis|window)\s*,\s*(['"`])([\w$]+)\3/g;
        while ((m = reGlobal2.exec(text))) {
            const g = m[2] || m[4];
            if (!IGNORED_GLOBALS.has(g) && g.length > 2 && !g.startsWith('webpackChunk')) fp.globals.add(g);
        }

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
    // keys: raw strings to search in source when building snippets for the AI review
    const push = (sev, title, items, hint, keys = items, review = true) => {
        if (items.length) out.push({ sev, title, items, hint, keys, review, a: A.label, b: B.label, aRef: A, bRef: B });
    };
    const fa = A.fp;
    const fb = B.fp;
    const both = (x, y) => intersect(x, y);

    if (fa.hash && fa.hash === fb.hash) {
        // Everything overlaps by definition; one finding says it all
        const n = fa.commands.size;
        push('danger', '같은 확장이 두 번 설치된 것 같아요', [`소스 코드가 완전히 같음${n ? ` (슬래시 명령 ${n}개 등 전부 겹침)` : ''}`], '하나를 지우세요. 명령·설정이 전부 겹칩니다.', [], false);
        return out;
    }
    let x = both(fa.commands, fb.commands);
    push('danger', '같은 슬래시 명령', x.map(v => `/${v}`), '나중에 로드된 쪽이 앞의 명령을 덮어씁니다.', x);
    x = both(fa.macros, fb.macros);
    push('danger', '같은 매크로', x.map(v => `{{${v}}}`), '한쪽 매크로가 다른 쪽을 덮어씁니다.', x);
    push('danger', '같은 함수 도구(Function tool) 이름', both(fa.tools, fb.tools), 'AI가 호출할 때 한쪽만 동작합니다.');
    if (fa.interceptor && fa.interceptor === fb.interceptor) {
        push('danger', '같은 생성 인터셉터 함수 이름', [fa.interceptor], '전역 함수가 덮어써져 한쪽 인터셉터가 두 번 돌고 다른 쪽은 안 돕니다.');
    } else if (fa.interceptor && fb.interceptor) {
        push('info', '둘 다 프롬프트를 가로채서 수정함', [`${fa.interceptor} / ${fb.interceptor}`], 'loading_order 순서대로 실행됩니다. 결과가 이상하면 순서를 확인하세요.', [fa.interceptor, fb.interceptor]);
    }
    x = both(fa.globals, fb.globals);
    push('danger', '같은 전역 변수(window.*)에 대입', x.map(v => `window.${v}`), '나중에 로드된 쪽 값만 남습니다.', x);
    push('danger', '같은 extension_settings 키에 저장', both(fa.settingsKeys, fb.settingsKeys), '서로의 설정을 덮어써서 설정이 초기화되거나 꼬일 수 있어요.');
    x = both(fa.domIds, fb.domIds);
    push('danger', '같은 HTML id 생성', x.map(v => `#${v}`), 'getElementById가 엉뚱한 요소를 잡아 UI가 깨질 수 있어요.', x);
    x = both(fa.patches, fb.patches);
    push('caution', '같은 대상을 몽키패치(덮어쓰기)', x, '여러 확장이 같은 함수를 감싸요. 각자 원래 함수를 이어서 부르면 괜찮지만, 그러지 않으면 한쪽 기능이 사라져요. AI 검토로 확인해 보세요.', x.map(v => v.split('.').pop()));
    x = both(fa.hotkeys, fb.hotkeys);
    push('caution', '같은 단축키', x, '키를 누르면 두 동작이 동시에 일어날 수 있어요.', ['keydown']);
    x = both(fa.firstLast, fb.firstLast);
    push('caution', '같은 이벤트에서 둘 다 "맨 앞/맨 뒤"를 요구', x, '둘 다 먼저(또는 나중에) 실행되려 해서 순서가 보장되지 않아요.', x.map(v => v.split(':')[1]));

    const css = [];
    const cssKeys = [];
    for (const [sel, props] of fa.cssImportant) {
        const other = fb.cssImportant.get(sel);
        if (!other) continue;
        const shared = intersect(props, other);
        if (shared.length) {
            css.push(`${sel} { ${shared.join(', ')} }`);
            cssKeys.push(sel);
        }
    }
    push('caution', 'CSS !important 가 같은 곳에 겹침', css, '나중에 로드된 스타일이 이깁니다. 화면이 의도와 다르게 보일 수 있어요.', cssKeys);

    const sharedEvents = intersect(fa.events, fb.events);
    if (sharedEvents.length >= 4) {
        push('info', '같은 이벤트를 많이 구독', sharedEvents, '대부분 문제 없지만, 둘 다 메시지 내용을 수정한다면 결과가 섞일 수 있어요.',
            sharedEvents.filter(e => MUTATING_EVENTS.has(e)), sharedEvents.some(e => MUTATING_EVENTS.has(e)));
    }
    return out;
}

// Events where handlers typically rewrite messages or prompts: worth an AI look when shared
const MUTATING_EVENTS = new Set([
    'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_EDITED',
    'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_COMBINE_PROMPTS', 'GENERATE_BEFORE_COMBINE_PROMPTS',
    'GENERATION_AFTER_COMMANDS', 'MESSAGE_SWIPED', 'STREAM_TOKEN_RECEIVED',
]);

/**
 * Pairwise findings with the same title and items (e.g. three extensions all patching fetch)
 * become one finding that lists every extension involved. Exported for testing.
 */
export function mergeFindings(findings) {
    const groups = new Map();
    for (const f of findings) {
        const key = `${f.sev}|${f.title}|${[...f.items].sort().join(',')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    const out = [];
    for (const list of groups.values()) {
        if (list.length === 1 || !list[0].b) {
            out.push(...list);
            continue;
        }
        const names = [...new Set(list.flatMap(f => [f.a, f.b]))];
        out.push({ ...list[0], a: names.join(' · '), b: '', group: names.length });
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
                files,
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
        files,
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

    findings.forEach((f, i) => { f.id = `F${i + 1}`; });
    const reviewable = findings.filter(f => f.review && f.aRef && f.bRef);
    lastReport = { findings };

    const row = f => `
        <div class="ecc-item ecc-${f.sev}" data-fid="${f.id}">
            <div class="ecc-item-head">
                <span class="ecc-badge">${sevLabel[f.sev]}</span>
                <b>${esc(f.title)}</b>
            </div>
            <div class="ecc-pair">${f.group ? `<small>확장 ${f.group}개:</small> ` : ''}${esc(f.a)}${f.b ? ` <i class="fa-solid fa-arrows-left-right"></i> ${esc(f.b)}` : ''}</div>
            <ul>${f.items.slice(0, 12).map(i => `<li><code>${esc(i)}</code></li>`).join('')}${f.items.length > 12 ? `<li>…외 ${f.items.length - 12}개</li>` : ''}</ul>
            <div class="ecc-hint">${esc(f.hint)}</div>
        </div>`;
    const main = findings.filter(f => f.sev !== 'info').map(row).join('');
    const infos = findings.filter(f => f.sev === 'info');
    const rows = main + (infos.length ? `<details class="ecc-info-group"><summary>참고 ${infos.length}건 보기 <small>(대부분 문제없는 항목)</small></summary>${infos.map(row).join('')}</details>` : '');

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
        ${reviewable.length ? `<div class="ecc-ai-box">
            <div class="menu_button menu_button_icon ecc-ai-btn"><i class="fa-solid fa-robot"></i><span>AI로 진짜 충돌인지 검토 (${Math.min(reviewable.length, AI_MAX_FINDINGS)}건)</span></div>
            <small>걸린 부분의 코드 조각만 ${esc(aiTargetLabel())}로 보내요.</small>
            <div class="ecc-ai-out"></div>
        </div>` : ''}
        ${rows || ''}
        <details class="ecc-scanned"><summary>검사한 확장 목록</summary>
            <ul>${scanned.map(e => `<li><b>${esc(e.label)}</b> <small>${esc(e.manifest.version || '')}${e.enabled === false ? ' (꺼짐)' : ''}</small><br><small>${esc(summarizeFp(e.fp))}</small></li>`).join('')}</ul>
        </details>
        <div class="ecc-note">코드를 정적으로 읽어서 찾은 "가능성"이에요. 압축(번들)된 확장은 일부 항목을 못 찾을 수 있고, 표시돼도 실제로는 문제없을 수 있어요.</div>
    </div>`;
}

// ---------------------------------------------------------------- AI review

const AI_MAX_FINDINGS = 15;
const SNIPPET_CHARS = 2200;
const TOTAL_PROMPT_CHARS = 34000;
let lastReport = null;
let aiBusy = false;
let lastRaw = '';

// English names for finding types (the model reads these)
const TITLE_EN = {
    '같은 슬래시 명령': 'Same slash command name registered by both',
    '같은 매크로': 'Same macro name registered by both',
    '같은 함수 도구(Function tool) 이름': 'Same function-calling tool name',
    '같은 생성 인터셉터 함수 이름': 'Same generate_interceptor global function name',
    '둘 다 프롬프트를 가로채서 수정함': 'Both use a generate_interceptor that edits the prompt',
    '같은 전역 변수(window.*)에 대입': 'Both assign the same window/globalThis property',
    '같은 extension_settings 키에 저장': 'Both write the same extension_settings key',
    '같은 HTML id 생성': 'Both create an element with the same HTML id',
    '같은 대상을 몽키패치(덮어쓰기)': 'Both monkey-patch the same shared function',
    '같은 단축키': 'Both bind the same keyboard shortcut',
    '같은 이벤트에서 둘 다 "맨 앞/맨 뒤"를 요구': 'Both call eventSource.makeFirst/makeLast on the same event',
    'CSS !important 가 같은 곳에 겹침': 'Both set the same CSS property with !important on the same selector',
    '같은 이벤트를 많이 구독': 'Both subscribe to events where handlers usually rewrite messages or prompts',
};

const VERDICT = {
    real: { text: '충돌 확실', cls: 'ecc-danger' },
    likely: { text: '충돌 가능성 높음', cls: 'ecc-caution' },
    unlikely: { text: '문제 적음', cls: 'ecc-info' },
    false_positive: { text: '오탐 (괜찮음)', cls: 'ecc-ok' },
};

function aiTargetLabel() {
    const id = getSettings().aiProfileId;
    if (!id) return '현재 연결된 API';
    const p = SillyTavern.getContext().extensionSettings.connectionManager?.profiles?.find(x => x.id === id);
    return p ? `"${p.name}" 프로필` : '현재 연결된 API';
}

/**
 * Sends ONLY the given system + user messages.
 * With a profile: the profile's API, model, key and proxy are used; the profile's preset
 * (prompt order, samplers) and instruct template are skipped unless usePreset is on.
 * Without a profile: falls back to the current connection via generateRaw (no chat, no character card).
 */
/**
 * Without a preset, SillyTavern does not send Vertex AI's auth mode with profile requests, so the
 * server falls back to Express (API key) mode and Google rejects service-account setups with
 * "API keys are not supported by this API". Fill those fields from the current settings.
 */
function profileOverrides(profileId) {
    const ctx = SillyTavern.getContext();
    const cc = ctx.chatCompletionSettings || {};
    const out = {};
    if (cc.vertexai_auth_mode) out.vertexai_auth_mode = cc.vertexai_auth_mode;
    if (cc.vertexai_express_project_id) out.vertexai_express_project_id = cc.vertexai_express_project_id;
    const profile = ctx.extensionSettings.connectionManager?.profiles?.find(p => p.id === profileId);
    if (profile && !profile['api-url'] && cc.vertexai_region) out.vertexai_region = cc.vertexai_region;
    return out;
}

async function callLLM(system, user, maxTokens, profileId, usePreset = false) {
    const ctx = SillyTavern.getContext();
    if (profileId && ctx.ConnectionManagerRequestService) {
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
            { stream: false, extractData: true, includePreset: !!usePreset, includeInstruct: !!usePreset },
            profileOverrides(profileId),
        );
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    return await ctx.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
}

function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Code around the first place `key` appears in an extension's files. */
export function snippetFor(ext, key) {
    if (!ext?.files || !key) return '';
    const quoted = new RegExp(`(['"\`])${escRe(key)}\\1`);
    for (const useQuoted of [true, false]) {
        for (const f of ext.files) {
            let idx = -1;
            if (useQuoted) {
                const m = quoted.exec(f.text);
                idx = m ? m.index : -1;
            } else {
                idx = f.text.indexOf(key);
            }
            if (idx < 0) continue;
            const lineNo = f.text.slice(0, idx).split('\n').length;
            const lineStart = f.text.lastIndexOf('\n', idx) + 1;
            const lineEnd = f.text.indexOf('\n', idx);
            const lineLen = (lineEnd < 0 ? f.text.length : lineEnd) - lineStart;
            let body;
            if (lineLen > 400) {
                // Minified/bundled code: take a character window instead of lines
                body = f.text.slice(Math.max(0, idx - 700), idx + 700);
            } else {
                const lines = f.text.split('\n');
                body = lines.slice(Math.max(0, lineNo - 11), lineNo + 10).map(l => l.length > 220 ? `${l.slice(0, 220)}…` : l).join('\n');
            }
            return `// ${f.path}:${lineNo}\n${body}`.slice(0, SNIPPET_CHARS);
        }
    }
    return '';
}

// Editable part of the review instructions (the user can replace it in settings)
export const DEFAULT_REVIEW_PROMPT = [
    'You are an expert reviewer of SillyTavern browser extensions (ES modules that run in the same page and share window, the DOM, eventSource and extension_settings).',
    'A regex-based static scanner flagged possible conflicts between pairs of extensions. Read the code excerpts and decide whether each one is a real runtime conflict when both extensions are enabled.',
    'Be concrete and skeptical: a shared name only matters if both sides really register/overwrite it in a way that breaks the other. Reading a shared value, or namespacing it, is not a conflict.',
    'The end user is a non-developer who reads Korean. Write every "title", "explanation", "fix" and "summary" value in Korean, at most 2 short plain sentences each, no code unless essential.',
    'Use "extra" only for conflicts the scanner missed that are clearly visible in the excerpts (for example both rewrite message text in the same event, or both inject prompts at the same depth). Otherwise return an empty array.',
].join('\n');

// Fixed part: the parser depends on it, so it is always appended
const REVIEW_FORMAT = [
    'Output format (required): return ONLY a JSON object, no markdown fences, with this shape:',
    '{"findings":[{"id":"F1","verdict":"real|likely|unlikely|false_positive","explanation":"...","fix":"..."}],',
    ' "extra":[{"extensions":"A <-> B","title":"...","explanation":"...","fix":"..."}],',
    ' "summary":"..."}',
    'Include one entry in "findings" for every finding id you were given.',
].join('\n');

export function buildReviewPrompt(findings, customPrompt = '') {
    const system = `${String(customPrompt || '').trim() || DEFAULT_REVIEW_PROMPT}\n\n${REVIEW_FORMAT}`;

    let user = 'Findings to review:\n';
    for (const f of findings) {
        const head = `\n### ${f.id} [${f.sev}] ${TITLE_EN[f.title] || f.title}\nExtension A: ${f.a}\nExtension B: ${f.b}\nFlagged items: ${f.items.slice(0, 8).join(', ')}\n`;
        const keys = (f.keys || []).slice(0, 2);
        let code = '';
        for (const k of keys) {
            const sa = snippetFor(f.aRef, k);
            const sb = snippetFor(f.bRef, k);
            if (sa) code += `--- A excerpt (${k}) ---\n${sa}\n`;
            if (sb) code += `--- B excerpt (${k}) ---\n${sb}\n`;
        }
        if (!code) code = '(no excerpt found; judge from the description only)\n';
        if (user.length + head.length + code.length > TOTAL_PROMPT_CHARS) {
            user += `\n### ${f.id}: skipped (prompt size limit). Return verdict "likely" with explanation noting it was not reviewed.\n`;
            continue;
        }
        user += head + code;
    }
    return { system, user };
}

/**
 * Pulls the JSON object out of a model reply. Handles code fences, thinking tags, trailing commas
 * and replies cut off by the token limit (keeps every finding that was complete). Exported for testing.
 */
export function parseJsonLoose(text) {
    let t = String(text || '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{');
    if (a < 0) throw new Error('AI 응답에서 JSON을 찾지 못했어요.');
    t = t.slice(a);
    const tryParse = (str) => {
        try {
            return JSON.parse(str.replace(/,\s*([}\]])/g, '$1'));
        } catch {
            return undefined;
        }
    };
    const b = t.lastIndexOf('}');
    const whole = b > 0 ? tryParse(t.slice(0, b + 1)) : undefined;
    if (whole) return whole;

    // Repair: remember every point where an object/array closed, then close what is still open
    const cuts = [];
    const stack = [];
    let inStr = false;
    let escNext = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            if (escNext) escNext = false;
            else if (c === '\\') escNext = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
        else if (c === '}' || c === ']') {
            stack.pop();
            cuts.push({ end: i + 1, closers: stack.slice().reverse().join('') });
            if (!stack.length) break;
        }
    }
    for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 200; k--) {
        const r = tryParse(t.slice(0, cuts[k].end) + cuts[k].closers);
        if (r && (Array.isArray(r.findings) || r.summary || r.extra)) {
            r.truncated = true;
            return r;
        }
    }
    throw new Error('AI 응답이 중간에 잘렸거나 형식이 달라요. 설정에서 최대 응답 토큰을 늘려 보세요.');
}

/** Accepts "F1", "f1", "1" and object-shaped findings. */
export function normalizeReview(result) {
    let list = result?.findings;
    if (list && !Array.isArray(list) && typeof list === 'object') {
        list = Object.entries(list).map(([id, v]) => ({ id, ...(typeof v === 'object' ? v : { verdict: v }) }));
    }
    const verdictMap = { real: 'real', likely: 'likely', unlikely: 'unlikely', false_positive: 'false_positive', falsepositive: 'false_positive', 'false positive': 'false_positive' };
    return {
        findings: (Array.isArray(list) ? list : []).map(f => ({
            ...f,
            id: /^\d+$/.test(String(f.id ?? '').trim()) ? `F${String(f.id).trim()}` : String(f.id ?? '').trim().toUpperCase(),
            verdict: verdictMap[String(f.verdict || '').toLowerCase().trim()] || 'likely',
        })),
        extra: Array.isArray(result?.extra) ? result.extra : [],
        summary: typeof result?.summary === 'string' ? result.summary : '',
        truncated: !!result?.truncated,
    };
}

async function runAiReview(button) {
    if (aiBusy || !lastReport) return;
    const s = getSettings();
    const { Popup, POPUP_RESULT, saveSettingsDebounced } = SillyTavern.getContext();
    if (!s.aiConsent) {
        const ok = await Popup.show.confirm('AI 검토', `걸린 부분 주변의 확장 코드 조각(최대 약 3만 자)이 ${aiTargetLabel()}로 전송되고, 요청 1번만큼 비용이 들어요. 계속할까요?`);
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        s.aiConsent = true;
        saveSettingsDebounced();
    }

    const findings = lastReport.findings.filter(f => f.review && f.aRef && f.bRef).slice(0, AI_MAX_FINDINGS);
    const box = button.closest('.ecc-ai-box');
    const out = box?.querySelector('.ecc-ai-out');
    const label = button.querySelector('span');
    const original = label?.textContent;
    aiBusy = true;
    lastRaw = '';
    button.classList.add('disabled');
    if (label) label.textContent = 'AI가 코드를 읽는 중…';

    try {
        const { system, user } = buildReviewPrompt(findings, s.aiPrompt);
        const raw = await callLLM(system, user, s.aiMaxTokens || 8000, s.aiProfileId, s.aiUsePreset);
        if (!String(raw || '').trim()) throw new Error('AI가 빈 답을 보냈어요. 추론 모델이면 설정에서 최대 응답 토큰을 늘려 보세요.');
        lastRaw = String(raw);
        const result = normalizeReview(parseJsonLoose(raw));
        const scope = button.closest('.ecc-report') || document;

        let real = 0;
        for (const r of result.findings || []) {
            const v = VERDICT[r.verdict] || VERDICT.likely;
            if (r.verdict === 'real' || r.verdict === 'likely') real++;
            const item = scope.querySelector(`.ecc-item[data-fid="${CSS.escape(String(r.id))}"]`);
            if (!item) continue;
            item.querySelector('.ecc-ai')?.remove();
            item.insertAdjacentHTML('beforeend', `<div class="ecc-ai"><span class="ecc-badge ${v.cls}"><i class="fa-solid fa-robot"></i> ${v.text}</span>
                <div>${esc(r.explanation)}</div>${r.fix ? `<div class="ecc-ai-fix">해결: ${esc(r.fix)}</div>` : ''}</div>`);
            if (r.verdict === 'false_positive') item.classList.add('ecc-dim');
        }
        const extra = (result.extra || []).map(e => `<div class="ecc-item ecc-caution"><div class="ecc-item-head"><span class="ecc-badge">AI 발견</span><b>${esc(e.title)}</b></div>
            <div class="ecc-pair">${esc(e.extensions)}</div><div>${esc(e.explanation)}</div>${e.fix ? `<div class="ecc-ai-fix">해결: ${esc(e.fix)}</div>` : ''}</div>`).join('');
        if (out) {
            const missing = findings.length - (result.findings || []).length;
            out.innerHTML = `<div class="ecc-ai-summary"><b>AI 결론</b> · 실제 문제 가능성 ${real}건 / 검토 ${findings.length}건<br>${esc(result.summary || '')}${missing > 0 ? `<br><small>${result.truncated ? '답이 중간에 잘려서 ' : ''}${missing}건은 판정을 못 받았어요.${result.truncated ? ' 설정에서 최대 응답 토큰을 늘리면 돼요.' : ''}</small>` : ''}</div>${extra}`;
        }
        if (label) label.textContent = 'AI 검토 완료 (다시 검토)';
    } catch (err) {
        console.error(LOG, 'AI review failed', err);
        let msg = err?.cause?.message || err?.message || String(err);
        if (/No message generated/i.test(msg)) msg = 'AI가 빈 답을 보냈어요. 추론 모델이면 설정에서 최대 응답 토큰을 늘리거나, 다른 연결 프로필을 골라 보세요.';
        if (out) out.innerHTML = `<div class="ecc-ai-summary ecc-danger">AI 검토 실패: ${esc(msg)}${lastRaw ? `<details><summary>AI가 보낸 답 보기</summary><pre class="ecc-raw">${esc(lastRaw.slice(0, 4000))}</pre></details>` : ''}</div>`;
        if (label) label.textContent = original;
        toastr.error(msg, 'AI 검토 실패');
    } finally {
        aiBusy = false;
        button.classList.remove('disabled');
    }
}

function fillProfileSelect(select, currentId) {
    const ctx = SillyTavern.getContext();
    let profiles = [];
    try {
        profiles = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch {
        profiles = []; // Connection Manager disabled
    }
    select.innerHTML = '<option value="">현재 연결 사용 (프로필 없음)</option>'
        + profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    select.value = profiles.some(p => p.id === currentId) ? currentId : '';
}

async function showReport(html) {
    const { Popup, POPUP_TYPE } = SillyTavern.getContext();
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

// ---------------------------------------------------------------- actions

let checking = false;

/**
 * Shows a loading toast only while scanning. The toast has no stop button: SillyTavern's default
 * stop action would cancel the user's text generation, not this scan.
 */
async function withLoader(message, fn) {
    const { loader } = SillyTavern.getContext();
    let handle = null;
    try {
        handle = loader?.show ? loader.show({ message, blocking: false, toastMode: loader.ToastMode?.STATIC ?? 'static' }) : null;
    } catch {
        handle = null;
    }
    try {
        return await fn();
    } finally {
        try {
            await handle?.hide?.();
        } catch { /* already gone */ }
    }
}

async function checkLink(link, { silent = false } = {}) {
    if (checking) {
        toastr.info('이미 검사 중이에요.');
        return '';
    }
    if (!link) {
        toastr.warning('검사할 확장의 GitHub 링크를 넣어 주세요.');
        return '';
    }
    checking = true;
    try {
        const result = await withLoader('확장 코드를 읽는 중…', async () => {
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
            return { html, text: summaryText(findings) };
        });
        // Close the loading toast first, then show the result
        if (!silent) await showReport(result.html);
        return result.text;
    } catch (err) {
        console.error(LOG, err);
        toastr.error(err.message || String(err), '충돌 검사 실패');
        return `error: ${err.message}`;
    } finally {
        checking = false;
    }
}

async function checkInstalled({ silent = false } = {}) {
    if (checking) {
        toastr.info('이미 검사 중이에요.');
        return '';
    }
    checking = true;
    try {
        const result = await withLoader('설치된 확장을 읽는 중…', async () => {
            const installed = filterInstalled(await loadInstalled(true));
            const findings = [];
            for (let i = 0; i < installed.length; i++) {
                for (let j = i + 1; j < installed.length; j++) {
                    findings.push(...compare(installed[i], installed[j]));
                }
            }
            const html = renderReport('설치된 확장끼리 충돌 검사', mergeFindings(findings), installed);
            return { html, text: summaryText(findings) };
        });
        // Close the loading toast first, then show the result
        if (!silent) await showReport(result.html);
        return result.text;
    } catch (err) {
        console.error(LOG, err);
        toastr.error(err.message || String(err), '충돌 검사 실패');
        return `error: ${err.message}`;
    } finally {
        checking = false;
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
                <label for="ecc_ai_profile">AI 검토에 쓸 연결</label>
                <select id="ecc_ai_profile" class="text_pole"></select>
                <small>프로필을 고르면 그 프로필의 API·모델·키·프록시로, 아래 프롬프트만 보내요(프리셋·캐릭터·채팅은 안 들어감). 프로필은 ST의 Connection Profiles에서 만들어요.</small>
                <label class="checkbox_label"><input id="ecc_ai_preset" type="checkbox" /><span>프로필에 묶인 프리셋 설정(온도 등)도 적용</span></label>
                <label for="ecc_ai_max">최대 응답 토큰</label>
                <input id="ecc_ai_max" class="text_pole" type="number" min="500" max="16000" step="100" />
                <label for="ecc_ai_prompt">AI 검토 프롬프트 (비우면 기본값)</label>
                <textarea id="ecc_ai_prompt" class="text_pole" rows="6"></textarea>
                <div class="flex-container">
                    <div id="ecc_ai_prompt_default" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i><span>기본 프롬프트 불러오기</span></div>
                </div>
                <small>출력 형식(JSON) 안내는 결과를 읽기 위해 항상 뒤에 자동으로 붙어요. 모델이 읽는 글이라 영어를 권장해요.</small>
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

    const sel = document.getElementById('ecc_ai_profile');
    fillProfileSelect(sel, s.aiProfileId);
    sel.addEventListener('focus', () => fillProfileSelect(sel, s.aiProfileId));
    sel.addEventListener('change', () => { s.aiProfileId = sel.value; saveSettingsDebounced(); });

    const preset = document.getElementById('ecc_ai_preset');
    preset.checked = !!s.aiUsePreset;
    preset.addEventListener('change', () => { s.aiUsePreset = preset.checked; saveSettingsDebounced(); });
    const max = document.getElementById('ecc_ai_max');
    max.value = s.aiMaxTokens;
    max.addEventListener('change', () => {
        s.aiMaxTokens = Math.min(16000, Math.max(500, parseInt(max.value) || 8000));
        max.value = s.aiMaxTokens;
        saveSettingsDebounced();
    });
    const prompt = document.getElementById('ecc_ai_prompt');
    prompt.value = s.aiPrompt;
    prompt.placeholder = DEFAULT_REVIEW_PROMPT;
    prompt.addEventListener('input', () => { s.aiPrompt = prompt.value; saveSettingsDebounced(); });
    document.getElementById('ecc_ai_prompt_default').addEventListener('click', () => {
        prompt.value = DEFAULT_REVIEW_PROMPT;
        s.aiPrompt = '';
        saveSettingsDebounced();
    });
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
            // The AI button lives inside report popups: one delegated handler
            document.addEventListener('click', (e) => {
                const btn = e.target instanceof Element ? e.target.closest('.ecc-ai-btn') : null;
                if (btn) runAiReview(btn);
            });
            for (const ev of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_DELETED, event_types.CONNECTION_PROFILE_UPDATED]) {
                if (ev) eventSource.on(ev, () => {
                    const sel = document.getElementById('ecc_ai_profile');
                    if (sel) fillProfileSelect(sel, getSettings().aiProfileId);
                });
            }
            console.log(LOG, 'ready', SELF_FOLDER);
        } catch (err) {
            console.error(LOG, 'init failed', err);
        }
    });
}
