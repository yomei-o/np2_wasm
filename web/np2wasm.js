// Page logic for the NP2kai wasm demo.
//
// The emulator reads its config and mounts disks only at startup, so booting
// from a disk means reloading the page with that disk already assigned to a
// drive. MEMFS does not survive a reload, so images live in IndexedDB and the
// drive assignment in localStorage. Writes the guest makes land in MEMFS only,
// which is why every mounted image has a "保存" button that copies it back.

import { makeHdn } from './pc98fatapi.js';
import { initDiskBrowser, diskBrowserRefresh } from './diskbrowser.js';

// ---------------------------------------------------------------- machines
const MACHINES = {
	dx2: {
		label: 'PC-9801DX2 相当 (80286 12MHz)',
		js: 'emnp2kai_sdl2.js',
		cfg: 'np2kai.cfg',
		section: 'NekoProjectIIkai',
		// PC-9801DX: 80286-12MHz, 640KB + 1MB, two 5.25" 2HD drives, EGC.
		// clk_base 2.4576MHz x clk_mult 5 = 12.288MHz.
		settings: {
			pc_model: 'VX',
			clk_base: '2457600',
			clk_mult: '5',
			GRCG_EGC: '3',
			ExMemory: '1',
			fontfile: '/font.rom',
			FDDRIVE1: 'true',
			FDDRIVE2: 'true',
			FDDRIVE3: 'false',
			FDDRIVE4: 'false',
		},
	},
	ia32: {
		label: 'PC-9821 相当 (IA-32)',
		js: 'emnp21kai_sdl2.js',
		cfg: 'np21kai.cfg',
		section: 'NekoProject21kai',
		settings: {
			pc_model: 'VX',
			clk_base: '2457600',
			clk_mult: '20',
			GRCG_EGC: '3',
			ExMemory: '13',
			fontfile: '/font.rom',
			FDDRIVE1: 'true',
			FDDRIVE2: 'true',
			FDDRIVE3: 'false',
			FDDRIVE4: 'false',
		},
	},
};

// SNDboard values are the SOUNDID_* constants from pccore.h. YM2608 (OPNA) is
// register-compatible with YM2203 (OPN), so 26K-era software runs on an 86
// board too; the 86 adds three more FM channels, stereo, the rhythm generator
// and ADPCM. A real PC-9801DX had no sound at all - both of these are boards
// you would have added.
const SOUND_BOARDS = [
	{ id: '00', label: '音源なし' },
	{ id: '02', label: 'PC-9801-26K (YM2203 / FM3+SSG3)' },
	{ id: '04', label: 'PC-9801-86 (YM2608 / FM6+SSG3+リズム)' },
	{ id: '06', label: 'PC-9801-86 + 26K' },
	{ id: '14', label: 'PC-9801-86 + ADPCM' },
	{ id: '08', label: 'PC-9801-118 (YMF288)' },
];

// np2's own opngen, or cisc's fmgen core. fmgen is the more faithful of the
// two and is what NP2kai defaults to.
const FM_CORES = [
	{ id: 'true', label: 'fmgen (既定)' },
	{ id: 'false', label: 'opngen (np2内蔵)' },
];

// OPNA rhythm samples. np2's rhythmc.c opens the lowercase names and fmgen's
// OPNA::LoadRhythmSample() the uppercase ones, and MEMFS is case-sensitive,
// so both spellings get written.
const RHYTHM_WAVS = ['2608_bd.wav', '2608_sd.wav', '2608_top.wav',
                     '2608_hh.wav', '2608_tom.wav', '2608_rim.wav'];

const FONT_ROM = 'bios/font.rom';
const PC98_IPL = 'bios/pc98_ipl.bin';

// Images shipped with the site. They behave like library entries that cannot
// be deleted.
const BUNDLED = [
	{ name: 'fd98_2hd.img', url: 'disk/fd98_2hd.img', note: 'FreeDOS(98) 起動FD' },
	{ name: 'tools_98.xdf', url: 'disk/tools_98.xdf',
	  note: 'VZ Editor 1.6 + LHA / UnZip / Zip' },
	{ name: 'lsic_98.xdf', url: 'disk/lsic_98.xdf', note: 'LSI C-86 3.30c 試食版' },
];

// np2_main() decides what a positional image is from its extension, and fills
// FDD1/FDD2 and SCSIHDD0..3 in the order the arguments appear.
const FD_EXT = ['d88', 'd98', 'fdi', 'hdm', 'xdf', 'dup', '2hd', 'nfd', 'fdd',
                'hd4', 'hd5', 'hd9', 'h01', 'hdb', 'ddb', 'dd6', 'dd9', 'dcp',
                'dcu', 'flp', 'bin', 'tfd', 'fim', 'img', 'ima'];
const HD_EXT = ['hdn', 'hds', 'hdd', 'thd', 'nhd', 'hdi', 'vhd', 'sln'];

const HDD_SIZES = [10, 20, 40, 60, 100];

const SLOTS_KEY = 'np2wasm.slots';
const DB_NAME = 'np2wasm';
const DB_STORE = 'disks';

const $ = (id) => document.getElementById(id);

function setStatus(text, isError) {
	const el = $('status');
	el.textContent = text;
	el.classList.toggle('err', !!isError);
}

function extOf(name) {
	const i = name.lastIndexOf('.');
	return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function kindOf(name) {
	const ext = extOf(name);
	if (HD_EXT.includes(ext)) return 'hd';
	if (FD_EXT.includes(ext)) return 'fd';
	return 'fd';
}

function fmtSize(n) {
	return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB'
	                        : Math.round(n / 1024) + ' KB';
}

// ------------------------------------------------------------ disk library
function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore(DB_STORE, { keyPath: 'name' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function dbTx(mode, fn) {
	return openDb().then((db) => new Promise((resolve, reject) => {
		const tx = db.transaction(DB_STORE, mode);
		const req = fn(tx.objectStore(DB_STORE));
		tx.oncomplete = () => resolve(req && req.result);
		tx.onerror = () => reject(tx.error);
	}));
}

const diskLib = {
	list: () => dbTx('readonly', (st) => st.getAll()),
	put: (name, bytes) => dbTx('readwrite', (st) => st.put({ name, bytes })),
	remove: (name) => dbTx('readwrite', (st) => st.delete(name)),
};

// -------------------------------------------------------------- slot state
const SLOT_NAMES = { fdd1: 'FDD1', fdd2: 'FDD2', hdd1: 'SCSI0', hdd2: 'SCSI1' };
const FD_SLOTS = ['fdd1', 'fdd2'];
const HD_SLOTS = ['hdd1', 'hdd2'];

function readSlots() {
	const empty = { fdd1: null, fdd2: null, hdd1: null, hdd2: null };
	try {
		return Object.assign(empty, JSON.parse(localStorage.getItem(SLOTS_KEY) || '{}'));
	} catch (err) {
		return empty;
	}
}

function writeSlots(slots) {
	try {
		localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
	} catch (err) {
		console.warn('could not persist drive assignment:', err);
	}
}

function assign(slot, name) {
	const slots = readSlots();
	for (const key of Object.keys(slots)) {
		if (slots[key] === name) slots[key] = null;   // one drive at a time
	}
	slots[slot] = name;
	writeSlots(slots);
}

function eject(slot) {
	const slots = readSlots();
	slots[slot] = null;
	writeSlots(slots);
}

// -------------------------------------------------------------- url params
const params = new URLSearchParams(location.search);

function currentMachineKey() {
	const key = params.get('machine');
	return MACHINES[key] ? key : 'dx2';
}

function currentSoundId() {
	const id = params.get('snd');
	return SOUND_BOARDS.some((b) => b.id === id) ? id : '02';
}

function currentFmCore() {
	const id = params.get('fmgen');
	return FM_CORES.some((c) => c.id === id) ? id : 'true';
}

function reload(changes) {
	const next = new URLSearchParams(params);
	for (const [key, value] of Object.entries(changes || {})) next.set(key, value);
	location.search = '?' + next.toString();
}

// ------------------------------------------------------------------ config
function buildCfg(machine, haveFont, slots, mountedNames) {
	const settings = Object.assign({}, machine.settings, {
		SNDboard: currentSoundId(),
		USEFMGEN: currentFmCore(),
	});
	// np2_main() also fills these from positional arguments, but writing them
	// into the config keeps the assignment visible if the user opens F11.
	HD_SLOTS.forEach((slot, i) => {
		const name = slots[slot];
		if (name && mountedNames.has(name)) settings['SCSIHDD' + i] = '/disk/' + name;
	});
	const nl = String.fromCharCode(10);
	const lines = ['[' + machine.section + ']'];
	for (const [key, value] of Object.entries(settings)) {
		if (key === 'fontfile' && !haveFont) continue;
		lines.push(key + '=' + value);
	}
	return lines.join(nl) + nl;
}

async function fetchBytes(url) {
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		return new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		console.warn(url + ' unavailable:', err);
		return null;
	}
}

// --------------------------------------------------------------- selectors
const machineSel = $('machine');
for (const [key, machine] of Object.entries(MACHINES)) {
	machineSel.add(new Option(machine.label, key));
}
machineSel.value = currentMachineKey();
machineSel.addEventListener('change', () => reload({ machine: machineSel.value }));

const soundSel = $('sound');
for (const board of SOUND_BOARDS) soundSel.add(new Option(board.label, board.id));
soundSel.value = currentSoundId();
soundSel.addEventListener('change', () => reload({ snd: soundSel.value }));

const fmSel = $('fmcore');
for (const core of FM_CORES) fmSel.add(new Option(core.label, core.id));
fmSel.value = currentFmCore();
fmSel.addEventListener('change', () => reload({ fmgen: fmSel.value }));

const hddSizeSel = $('hddsize');
for (const mb of HDD_SIZES) hddSizeSel.add(new Option(mb + ' MB', String(mb)));
hddSizeSel.value = '100';

$('reboot').addEventListener('click', () => reload());

// --------------------------------------------------------- MEMFS <-> library
function memfsRead(name) {
	try {
		return window.Module.FS.readFile('/disk/' + name);
	} catch (err) {
		return null;
	}
}

function download(name, bytes) {
	const url = URL.createObjectURL(new Blob([bytes],
		{ type: 'application/octet-stream' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// -------------------------------------------------------------- disk panel
function button(text, title, onClick) {
	const b = document.createElement('button');
	b.textContent = text;
	if (title) b.title = title;
	b.addEventListener('click', onClick);
	return b;
}

async function renderDisks() {
	const table = $('disk-table');
	const slots = readSlots();
	const lib = await diskLib.list().catch(() => []);
	const rows = BUNDLED.map((b) => ({ name: b.name, note: b.note, size: null,
	                                   builtin: true }))
		.concat(lib.map((d) => ({ name: d.name, note: '',
		                          size: d.bytes.byteLength, builtin: false })));

	table.textContent = '';
	for (const row of rows) {
		const kind = kindOf(row.name);
		const slot = Object.keys(slots).find((k) => slots[k] === row.name) || '';
		const tr = document.createElement('tr');
		if (slot) tr.className = 'slotted';

		const sel = document.createElement('select');
		sel.add(new Option('入れない', ''));
		for (const s of (kind === 'hd' ? HD_SLOTS : FD_SLOTS)) {
			sel.add(new Option(SLOT_NAMES[s], s));
		}
		sel.value = slot;
		sel.addEventListener('change', () => {
			if (sel.value) assign(sel.value, row.name);
			else if (slot) eject(slot);
			renderDisks();
		});
		const tdSel = document.createElement('td');
		tdSel.appendChild(sel);

		const tdName = document.createElement('td');
		tdName.className = 'name';
		tdName.textContent = row.name;
		if (row.note) {
			const tag = document.createElement('span');
			tag.className = 'builtin';
			tag.textContent = '  ' + row.note;
			tdName.appendChild(tag);
		}

		const tdSize = document.createElement('td');
		tdSize.className = 'size';
		tdSize.textContent = row.size == null ? '' : fmtSize(row.size);

		const tdActions = document.createElement('td');
		tdActions.className = 'actions';
		if (slot) {
			tdActions.appendChild(button('取り出す', 'ドライブから外す', () => {
				eject(slot);
				renderDisks();
			}));
		}
		tdActions.appendChild(button('保存', '実行中の書き込み内容をライブラリに書き戻す',
			async () => {
				const data = memfsRead(row.name);
				if (!data) {
					setStatus(row.name + ' はまだマウントされていません。', true);
					return;
				}
				await diskLib.put(row.name, new Uint8Array(data));
				await renderDisks();
				setStatus(row.name + ' を保存しました (' + fmtSize(data.length) + ')。');
			}));
		tdActions.appendChild(button('DL', 'イメージをダウンロード', async () => {
			const live = memfsRead(row.name);
			if (live) {
				download(row.name, live);
				return;
			}
			const entry = lib.find((d) => d.name === row.name);
			if (entry) {
				download(row.name, new Uint8Array(entry.bytes));
				return;
			}
			const url = (BUNDLED.find((b) => b.name === row.name) || {}).url;
			if (url) location.href = url;
		}));
		if (!row.builtin) {
			tdActions.appendChild(button('削除', 'ライブラリから消す', async () => {
				if (slot) eject(slot);
				await diskLib.remove(row.name);
				renderDisks();
			}));
		}

		tr.append(tdSel, tdName, tdSize, tdActions);
		table.appendChild(tr);
	}

	const inDrives = Object.entries(slots)
		.filter(([, v]) => v)
		.map(([k, v]) => SLOT_NAMES[k] + '=' + v);
	$('disks-note').textContent = inDrives.length
		? '(起動時: ' + inDrives.join(' / ') + ' — 変更したら「この構成で再起動」)'
		: '(どのドライブにも入っていません)';
}

$('disk').addEventListener('change', async (event) => {
	const files = [...event.target.files];
	if (!files.length) return;
	for (const file of files) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		await diskLib.put(file.name, bytes);
		try {
			window.Module.FS.writeFile('/disk/' + file.name, bytes);
		} catch (err) {
			console.warn('could not add to the running machine:', err);
		}
		const slots = readSlots();
		const wanted = kindOf(file.name) === 'hd' ? HD_SLOTS : FD_SLOTS;
		const free = wanted.find((s) => !slots[s]);
		if (free) assign(free, file.name);
	}
	event.target.value = '';
	await renderDisks();
	diskBrowserRefresh();
	setStatus(files.map((f) => f.name).join(', ') + ' を登録しました。'
	          + 'ドライブを確認して「この構成で再起動」で起動します。');
});

$('mkhdd').addEventListener('click', async () => {
	const mb = Number(hddSizeSel.value);
	const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	let name = 'scsi' + mb + 'm_' + stamp + '.hdn';
	const lib = await diskLib.list().catch(() => []);
	for (let n = 2; lib.some((d) => d.name === name); n++) {
		name = 'scsi' + mb + 'm_' + stamp + '_' + n + '.hdn';
	}
	setStatus(mb + 'MB の SCSI HDD イメージを作成しています…');
	try {
		const ipl = await fetchBytes(PC98_IPL);
		if (!ipl) throw new Error(PC98_IPL + ' を読み込めませんでした');
		const image = await makeHdn(mb, 'NP2WASM', ipl);
		await diskLib.put(name, image);
		const slots = readSlots();
		assign(slots.hdd1 ? 'hdd2' : 'hdd1', name);
		await renderDisks();
		diskBrowserRefresh();
		setStatus(name + ' を作成しました — ' + fmtSize(image.length)
		          + ' / 領域確保と FAT16 フォーマット済みなので、'
		          + '「この構成で再起動」でそのまま C: として使えます。');
	} catch (err) {
		setStatus('HDDイメージを作成できませんでした: ' + err.message, true);
	}
});

// ---------------------------------------------------------------- perf meter
// "It feels slow" is not something you can act on. np2wasm_cycles() in
// sdl/em/np2wasm_api.c reports emulated cycles, so this can say whether the
// machine is keeping up with the clock the config asked for, and separately
// whether the browser is getting a chance to paint.
const PERF_KEY = 'np2wasm.perf';

function startPerfMeter() {
	const el = $('perf');
	const cycles = () => window.Module.ccall('np2wasm_cycles', 'number', [], []);
	const targetHz = () => window.Module.ccall('np2wasm_targethz', 'number', [], []);

	let last = null;
	let frames = 0;
	let worstGap = 0;
	let lastFrame = performance.now();

	function onFrame(now) {
		frames++;
		worstGap = Math.max(worstGap, now - lastFrame);
		lastFrame = now;
		requestAnimationFrame(onFrame);
	}
	requestAnimationFrame(onFrame);

	setInterval(() => {
		let c, target;
		try {
			c = cycles();
			target = targetHz();
		} catch (err) {
			return;                     // not up yet
		}
		const now = performance.now();
		if (last) {
			const dt = (now - last.now) / 1000;
			const mhz = (c - last.c) / dt / 1e6;
			const pct = target ? (mhz * 1e6 / target * 100) : 0;
			const fps = frames / dt;
			const cls = pct >= 90 ? '' : pct >= 60 ? 'warn' : 'bad';
			el.textContent = '';
			const add = (label, value, klass) => {
				const span = document.createElement('span');
				if (klass) span.className = klass;
				span.append(label + ' ');
				const b = document.createElement('b');
				b.textContent = value;
				span.appendChild(b);
				el.appendChild(span);
			};
			add('速度', mhz.toFixed(2) + ' MHz / ' + (target / 1e6).toFixed(2)
			           + ' MHz = ' + pct.toFixed(0) + '%', cls);
			add('描画', fps.toFixed(0) + ' fps');
			add('最悪フレーム間隔', worstGap.toFixed(0) + ' ms',
			    worstGap > 100 ? 'bad' : worstGap > 40 ? 'warn' : '');
		}
		last = { now, c };
		frames = 0;
		worstGap = 0;
	}, 1000);
}

const perfToggle = $('perftoggle');
perfToggle.checked = localStorage.getItem(PERF_KEY) === '1';
$('perf').hidden = !perfToggle.checked;
perfToggle.addEventListener('change', () => {
	try { localStorage.setItem(PERF_KEY, perfToggle.checked ? '1' : '0'); } catch (err) {}
	$('perf').hidden = !perfToggle.checked;
});

// --------------------------------------------------------------------- boot
async function boot() {
	const machine = MACHINES[currentMachineKey()];
	const canvas = $('canvas');
	const slots = readSlots();

	setStatus('フォントとディスクを読み込んでいます…');

	const lib = await diskLib.list().catch(() => []);
	const byName = new Map(lib.map((d) => [d.name, new Uint8Array(d.bytes)]));

	// None of this is fatal: without the font only the built-in ANK font is
	// there and kanji stay blank, and with no disk the drives just start empty.
	const [fontRom, ...rest] = await Promise.all([
		fetchBytes(FONT_ROM),
		...RHYTHM_WAVS.map((name) => fetchBytes('bios/' + name)),
		...BUNDLED.map((b) => fetchBytes(b.url)),
	]);
	const rhythm = rest.slice(0, RHYTHM_WAVS.length);
	const bundled = rest.slice(RHYTHM_WAVS.length);
	BUNDLED.forEach((b, i) => {
		if (bundled[i] && !byName.has(b.name)) byName.set(b.name, bundled[i]);
	});

	// FDD1, FDD2, then the SCSI drives - np2_main() assigns each positional
	// image by extension, in order.
	const mounted = [...FD_SLOTS, ...HD_SLOTS]
		.map((s) => slots[s])
		.filter((n) => n && byName.has(n));
	const args = mounted.map((n) => '/disk/' + n);

	window.Module = {
		canvas,
		arguments: args,
		preRun: [function () {
			const FS = window.Module.FS;
			// font_load() picks its loader from the basename, so the font has
			// to be called font.rom.
			if (fontRom) FS.writeFile('/font.rom', fontRom);
			RHYTHM_WAVS.forEach((name, i) => {
				if (!rhythm[i]) return;
				FS.writeFile('/' + name, rhythm[i]);
				FS.writeFile('/' + name.toUpperCase(), rhythm[i]);
			});
			FS.mkdir('/disk');
			// Images in a drive always go in. Others go in too so the F11
			// menu can swap them mid-run, but only the small ones - copying
			// an unmounted 100MB hard disk into MEMFS on every load costs
			// seconds and hundreds of megabytes for nothing.
			const SWAPPABLE_MAX = 4 * 1024 * 1024;
			for (const [name, bytes] of byName) {
				if (mounted.includes(name) || bytes.length <= SWAPPABLE_MAX) {
					FS.writeFile('/disk/' + name, bytes);
				}
			}
			FS.writeFile('/' + machine.cfg,
			             buildCfg(machine, !!fontRom, slots, byName));
		}],
		print: (text) => console.log(text),
		printErr: (text) => console.warn(text),
		setStatus: (text) => { if (text) setStatus(text); },
		onRuntimeInitialized: () => {
			const board = SOUND_BOARDS.find((b) => b.id === currentSoundId());
			setStatus(machine.label + ' / ' + board.label
			          + (mounted.length ? ' / ' + mounted.join(' + ') : ' / ディスクなし')
			          + ' — 画面をクリックしてからキー入力してください');
			canvas.focus();
		},
	};

	await renderDisks();

	// The disk contents panel runs its own wasm module and only touches the
	// library, so it is safe to bring up alongside the emulator.
	initDiskBrowser({
		list: () => diskLib.list().catch(() => []),
		put: (name, image) => diskLib.put(name, image),
		memfsRead,
		bundledNames: () => BUNDLED.map((b) => b.name),
		bundledUrl: (name) => (BUNDLED.find((b) => b.name === name) || {}).url,
		onSaved: () => renderDisks(),
	}).catch((err) => console.warn('disk browser unavailable:', err));

	setStatus('エミュレータを読み込んでいます (' + machine.js + ')…');
	const script = document.createElement('script');
	script.src = machine.js;
	script.onerror = () => setStatus(machine.js + ' を読み込めませんでした。', true);
	document.body.appendChild(script);
}

boot();
