// The disk contents panel: look inside a floppy or hard disk image, pull files
// out, put files in.
//
// This is what makes "upload a source file and compile it in the emulator"
// possible without booting anything first. It runs pc98fat.wasm, a separate
// module from the emulator (tools/pc98fat/), so nothing here can disturb a
// running machine.
//
// It edits the library copy of an image. Changes take effect on the next
// reboot, and if the guest has been writing to a mounted image you want its
// 保存 button first so the tool sees those writes.

import createPc98Fat from './pc98fat.js';

const ATTR_DIR = 0x10;
const ATTR_READONLY = 0x01;

let fat = null;              // the wasm module
let ptr = 0;                 // image buffer inside wasm memory
let bytes = null;            // the Uint8Array we loaded
let openName = '';           // library name of the open image
let cwd = '/';
let dirty = false;

let host = null;             // { list, put, memfsRead, setStatus, onSaved }

function call(fn, ret, types, args) {
	return fat.ccall(fn, ret, types, args);
}

function err() {
	const message = call('pc98fat_error', 'string', [], []);
	return message || 'unknown error';
}

function join(dir, name) {
	return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

function parent(dir) {
	const trimmed = dir.replace(/\/+$/, '');
	const i = trimmed.lastIndexOf('/');
	return i <= 0 ? '/' : trimmed.slice(0, i);
}

function fmtSize(n) {
	return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB'
	     : n >= 1024 ? Math.round(n / 1024) + ' KB'
	     : n + ' B';
}

function release() {
	if (fat && ptr) {
		call('pc98fat_close', null, [], []);
		fat._free(ptr);
	}
	ptr = 0;
	bytes = null;
	openName = '';
	cwd = '/';
	dirty = false;
}

// ------------------------------------------------------------------ opening
async function openImage(name) {
	if (!fat) fat = await createPc98Fat();
	release();

	// Prefer what the running machine has, so writes the guest already made
	// are visible; fall back to the library copy.
	let data = host.memfsRead(name);
	if (data) {
		data = new Uint8Array(data);
	} else {
		const entry = (await host.list()).find((d) => d.name === name);
		if (entry) data = new Uint8Array(entry.bytes);
	}
	if (!data) {
		const url = host.bundledUrl(name);
		if (url) {
			const res = await fetch(url);
			if (res.ok) data = new Uint8Array(await res.arrayBuffer());
		}
	}
	if (!data) throw new Error(name + ' を読み込めませんでした');

	ptr = fat._malloc(data.length);
	fat.HEAPU8.set(data, ptr);
	bytes = data;
	const r = call('pc98fat_open', 'number', ['number', 'number'],
	               [ptr, data.length]);
	if (r !== 0) {
		const message = err();
		release();
		throw new Error(message);
	}
	openName = name;
	cwd = '/';
	dirty = false;
}

function entries(dir) {
	const n = call('pc98fat_list', 'number', ['string'], [dir]);
	if (n < 0) throw new Error(err());
	const text = call('pc98fat_listing', 'string', [], []);
	return text.split('\n').filter(Boolean).map((line) => {
		const [name, size, attr] = line.split('\t');
		return { name, size: Number(size), attr: Number(attr) };
	});
}

function readFile(path) {
	const size = call('pc98fat_size', 'number', ['string'], [path]);
	if (size < 0) throw new Error(err());
	const out = fat._malloc(size || 1);
	try {
		const got = call('pc98fat_read', 'number',
		                 ['string', 'number', 'number'], [path, out, size]);
		if (got < 0) throw new Error(err());
		return new Uint8Array(fat.HEAPU8.subarray(out, out + got));
	} finally {
		fat._free(out);
	}
}

function writeFile(path, data) {
	const buf = fat._malloc(data.length || 1);
	try {
		fat.HEAPU8.set(data, buf);
		const r = call('pc98fat_write', 'number',
		               ['string', 'number', 'number'], [path, buf, data.length]);
		if (r < 0) throw new Error(err());
		dirty = true;
	} finally {
		fat._free(buf);
	}
}

// -------------------------------------------------------------------- view
const $ = (id) => document.getElementById(id);

function download(name, data) {
	const url = URL.createObjectURL(new Blob([data],
		{ type: 'application/octet-stream' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function button(text, title, onClick) {
	const b = document.createElement('button');
	b.textContent = text;
	if (title) b.title = title;
	b.addEventListener('click', onClick);
	return b;
}

function note(text, isError) {
	const el = $('fat-note');
	el.textContent = text;
	el.classList.toggle('err', !!isError);
}

function render() {
	const table = $('fat-table');
	table.textContent = '';
	$('fat-path').textContent = openName ? openName + ':' + cwd : '';
	$('fat-up').disabled = cwd === '/';
	$('fat-save').disabled = !dirty;
	$('fat-add').disabled = !openName;
	$('fat-mkdir').disabled = !openName;

	if (!openName) {
		note('イメージを選んで「開く」を押してください。');
		return;
	}

	let list;
	try {
		list = entries(cwd);
	} catch (e) {
		note(e.message, true);
		return;
	}
	list.sort((a, b) => (b.attr & ATTR_DIR) - (a.attr & ATTR_DIR)
	                    || a.name.localeCompare(b.name));

	for (const item of list) {
		const isDir = !!(item.attr & ATTR_DIR);
		const path = join(cwd, item.name);
		const tr = document.createElement('tr');

		const tdName = document.createElement('td');
		tdName.className = 'name';
		if (isDir) {
			const a = document.createElement('a');
			a.href = '#';
			a.textContent = item.name + '/';
			a.addEventListener('click', (ev) => {
				ev.preventDefault();
				cwd = path;
				render();
			});
			tdName.appendChild(a);
		} else {
			tdName.textContent = item.name;
		}
		if (item.attr & ATTR_READONLY) {
			const tag = document.createElement('span');
			tag.className = 'builtin';
			tag.textContent = '  R';
			tdName.appendChild(tag);
		}

		const tdSize = document.createElement('td');
		tdSize.className = 'size';
		tdSize.textContent = isDir ? '' : fmtSize(item.size);

		const tdActions = document.createElement('td');
		tdActions.className = 'actions';
		if (!isDir) {
			tdActions.appendChild(button('取り出す', 'このファイルをダウンロード',
				() => {
					try {
						download(item.name, readFile(path));
					} catch (e) {
						note(e.message, true);
					}
				}));
		}
		tdActions.appendChild(button('削除', isDir ? '空のフォルダのみ削除できます'
		                                          : 'イメージから消す', () => {
			const r = call('pc98fat_delete', 'number', ['string'], [path]);
			if (r < 0) {
				note(err(), true);
				return;
			}
			dirty = true;
			render();
			note(item.name + ' を消しました。「保存」でイメージに反映されます。');
		}));

		tr.append(tdName, tdSize, tdActions);
		table.appendChild(tr);
	}

	const free = call('pc98fat_free_bytes', 'number', [], []);
	const total = call('pc98fat_total_bytes', 'number', [], []);
	note(list.length + ' 項目 / 空き ' + fmtSize(free) + ' / 全体 '
	     + fmtSize(total) + ' / FAT' + call('pc98fat_fat_bits', 'number', [], [])
	     + (dirty ? ' — 未保存の変更があります' : ''));
}

async function refreshImageList() {
	const sel = $('fat-image');
	const keep = sel.value;
	sel.textContent = '';
	const names = host.bundledNames()
		.concat((await host.list()).map((d) => d.name));
	for (const name of names) sel.add(new Option(name, name));
	if (names.includes(keep)) sel.value = keep;
}

export async function initDiskBrowser(hostApi) {
	host = hostApi;
	await refreshImageList();

	$('fat-open').addEventListener('click', async () => {
		const name = $('fat-image').value;
		if (!name) return;
		note(name + ' を開いています…');
		try {
			await openImage(name);
			render();
		} catch (e) {
			note(e.message, true);
			render();
		}
	});

	$('fat-up').addEventListener('click', () => {
		cwd = parent(cwd);
		render();
	});

	$('fat-mkdir').addEventListener('click', () => {
		const name = prompt('作成するフォルダ名 (8.3形式)');
		if (!name) return;
		const r = call('pc98fat_mkdir', 'number', ['string'], [join(cwd, name)]);
		if (r < 0) {
			note(err(), true);
			return;
		}
		dirty = true;
		render();
	});

	$('fat-add').addEventListener('click', () => $('fat-file').click());

	$('fat-file').addEventListener('change', async (event) => {
		const files = [...event.target.files];
		event.target.value = '';
		for (const file of files) {
			try {
				writeFile(join(cwd, file.name),
				          new Uint8Array(await file.arrayBuffer()));
			} catch (e) {
				note(file.name + ': ' + e.message, true);
				render();
				return;
			}
		}
		render();
		note(files.map((f) => f.name).join(', ')
		     + ' を入れました。「保存」でイメージに反映されます。');
	});

	$('fat-save').addEventListener('click', async () => {
		if (!openName || !dirty) return;
		const image = new Uint8Array(fat.HEAPU8.subarray(ptr, ptr + bytes.length));
		await host.put(openName, image);
		dirty = false;
		await refreshImageList();
		render();
		note(openName + ' を保存しました。「この構成で再起動」で反映されます。');
		if (host.onSaved) host.onSaved(openName);
	});

	render();
}

export function diskBrowserRefresh() {
	if (host) refreshImageList().then(render);
}
