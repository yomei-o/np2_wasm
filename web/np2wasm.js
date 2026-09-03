// Page logic for the NP2kai wasm demo.
//
// The emulator only reads its config and mounts disks at startup, so booting
// from a disk means reloading the page with that disk already assigned to a
// drive. MEMFS does not survive a reload, so added images are kept in
// IndexedDB and the drive assignment in localStorage.

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
const BOOT_DISK = {
	name: 'fd98_2hd.img',
	url: 'disk/fd98_2hd.img',
	note: 'FreeDOS(98) 同梱',
};

const SLOTS_KEY = 'np2wasm.slots';
const DB_NAME = 'np2wasm';
const DB_STORE = 'disks';

const $ = (id) => document.getElementById(id);

function setStatus(text, isError) {
	const el = $('status');
	el.textContent = text;
	el.classList.toggle('err', !!isError);
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
function readSlots() {
	try {
		const v = JSON.parse(localStorage.getItem(SLOTS_KEY) || '{}');
		return { fdd1: v.fdd1 || null, fdd2: v.fdd2 || null };
	} catch (err) {
		return { fdd1: null, fdd2: null };
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
	// A disk can only be in one drive at a time.
	for (const key of ['fdd1', 'fdd2']) {
		if (slots[key] === name) slots[key] = null;
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
function buildCfg(machine, haveFont) {
	const settings = Object.assign({}, machine.settings, {
		SNDboard: currentSoundId(),
		USEFMGEN: currentFmCore(),
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

$('reboot').addEventListener('click', () => reload());

// -------------------------------------------------------------- disk panel
function fmtSize(n) {
	return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB'
	                        : Math.round(n / 1024) + ' KB';
}

async function renderDisks() {
	const table = $('disk-table');
	const slots = readSlots();
	const lib = await diskLib.list().catch(() => []);
	const rows = [{ name: BOOT_DISK.name, size: null, builtin: true }].concat(
		lib.map((d) => ({
			name: d.name,
			size: d.bytes.byteLength,
			builtin: false,
		})));

	table.textContent = '';
	for (const row of rows) {
		const slot = slots.fdd1 === row.name ? 'fdd1'
		           : slots.fdd2 === row.name ? 'fdd2' : '';
		const tr = document.createElement('tr');
		if (slot) tr.className = 'slotted';

		const sel = document.createElement('select');
		sel.add(new Option('入れない', ''));
		sel.add(new Option('FDD1', 'fdd1'));
		sel.add(new Option('FDD2', 'fdd2'));
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
		if (row.builtin) {
			const tag = document.createElement('span');
			tag.className = 'builtin';
			tag.textContent = '  ' + BOOT_DISK.note;
			tdName.appendChild(tag);
		}

		const tdSize = document.createElement('td');
		tdSize.className = 'size';
		tdSize.textContent = row.size == null ? '' : fmtSize(row.size);

		const tdEject = document.createElement('td');
		if (slot) {
			const btn = document.createElement('button');
			btn.textContent = '取り出す';
			btn.addEventListener('click', () => {
				eject(slot);
				renderDisks();
			});
			tdEject.appendChild(btn);
		}

		const tdDel = document.createElement('td');
		if (!row.builtin) {
			const btn = document.createElement('button');
			btn.textContent = '削除';
			btn.addEventListener('click', async () => {
				if (slot) eject(slot);
				await diskLib.remove(row.name);
				renderDisks();
			});
			tdDel.appendChild(btn);
		}

		tr.append(tdSel, tdName, tdSize, tdEject, tdDel);
		table.appendChild(tr);
	}

	const inDrives = [slots.fdd1, slots.fdd2].filter(Boolean);
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
		// Also drop it into the running machine so the F11 menu can pick it up
		// without a reboot.
		try {
			window.Module.FS.writeFile('/disk/' + file.name, bytes);
		} catch (err) {
			console.warn('could not add to the running machine:', err);
		}
	}
	event.target.value = '';
	const slots = readSlots();
	if (!slots.fdd1) assign('fdd1', files[0].name);
	else if (!slots.fdd2 && files[1]) assign('fdd2', files[1].name);
	await renderDisks();
	setStatus(files.map((f) => f.name).join(', ') + ' を登録しました。'
	          + 'ドライブを選んで「この構成で再起動」で起動します。');
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
	const [fontRom, bootImage, ...rhythm] = await Promise.all([
		fetchBytes(FONT_ROM),
		fetchBytes(BOOT_DISK.url),
		...RHYTHM_WAVS.map((name) => fetchBytes('bios/' + name)),
	]);
	if (bootImage) byName.set(BOOT_DISK.name, bootImage);

	// np2_main() mounts positional image arguments into FDD1 then FDD2.
	const mounted = [slots.fdd1, slots.fdd2].filter((n) => n && byName.has(n));
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
			FS.writeFile('/' + machine.cfg, buildCfg(machine, !!fontRom));
			FS.mkdir('/disk');
			// Every known image goes into /disk, in or out of a drive, so the
			// F11 menu can swap disks while running.
			for (const [name, bytes] of byName) {
				FS.writeFile('/disk/' + name, bytes);
			}
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

	setStatus('エミュレータを読み込んでいます (' + machine.js + ')…');
	const script = document.createElement('script');
	script.src = machine.js;
	script.onerror = () => setStatus(machine.js + ' を読み込めませんでした。', true);
	document.body.appendChild(script);
}

boot();
