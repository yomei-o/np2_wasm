// Headless NP2kai run under node.
//
// SDL's dummy video/audio drivers keep the emulator out of the DOM, so this
// exercises np2_main() and the emulation loop with no browser. After letting it
// run, it dumps the PC-98 text VRAM, which shows what is on screen and proves
// the guest actually executed rather than just starting up.
//
//   node runtest.js [disk image ...]
//
// RUN_SECONDS  how long to let the emulator run (default 6)
// FONT_ROM     path to a font.rom to mount
// KEYS         unused placeholder
const fs = require('fs');
const path = require('path');
const createNP2 = require('./np2test.js');

// SDL's Emscripten audio backend only needs an AudioContext to exist in order
// to open a device; np2 will not create its sound engine at all without one
// (pccore.c sound_init -> sound_create -> soundmng_create). Recording is driven
// by sound_sync() from the device write paths, not by the audio callback, so a
// context that is never pumped is enough to capture sound.
function stubWebAudio() {
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = {};
  // Present, so SDL skips autoResumeAudioContext(), which wants a document.
  if (!globalThis.navigator.userActivation) {
    try { globalThis.navigator.userActivation = { hasBeenActive: true, isActive: true }; }
    catch { globalThis.navigator = Object.assign({}, globalThis.navigator,
              { userActivation: { hasBeenActive: true, isActive: true } }); }
  }
  class ScriptProcessorNode {
    constructor(bufferSize, inCh, outCh) {
      this.bufferSize = bufferSize;
      this.numberOfInputs = inCh;
      this.numberOfOutputs = outCh;
      this.onaudioprocess = null;
    }
    connect() {} disconnect() {}
  }
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 44100; this.state = 'running'; this.destination = {}; }
    createScriptProcessor(b, i, o) { return new ScriptProcessorNode(b, i, o); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
}
stubWebAudio();

const images = process.argv.slice(2);
const seconds = Number(process.env.RUN_SECONDS || 6);
const fontRom = process.env.FONT_ROM || '';

const cfg = [
  '[NekoProjectIIkai]',
  'pc_model=VX', 'clk_base=2457600', 'clk_mult=5',
  'ExMemory=' + (process.env.EXTMEM || '1'),
  'FDDRIVE1=true', 'FDDRIVE2=true', 'FDDRIVE3=false', 'FDDRIVE4=false',
  'GRCG_EGC=' + (process.env.GRCG || '3'),
  'SNDboard=' + (process.env.SND || '02'),
  'USEFMGEN=' + (process.env.FMGEN || 'false'),
].concat(fontRom ? ['fontfile=/font.rom'] : []).join('\n') + '\n';

// PC-98 keyboard scan codes, from the NKEY_* list in keystat.h.
const KEYS = {
	esc: 0x00, ret: 0x1c, enter: 0x1c, space: 0x34, tab: 0x0f, bs: 0x0e,
	up: 0x3a, left: 0x3b, right: 0x3c, down: 0x3d,
	rollup: 0x36, rolldown: 0x37, ins: 0x38, del: 0x39, home: 0x3e, help: 0x3f,
	xfer: 0x35,
	f1: 0x62, f2: 0x63, f3: 0x64, f4: 0x65, f5: 0x66,
	f6: 0x67, f7: 0x68, f8: 0x69, f9: 0x6a, f10: 0x6b,
	'1': 0x01, '2': 0x02, '3': 0x03, '4': 0x04, '5': 0x05,
	'6': 0x06, '7': 0x07, '8': 0x08, '9': 0x09, '0': 0x0a,
	a: 0x1d, b: 0x2d, c: 0x2b, d: 0x1f, e: 0x12, f: 0x20, g: 0x21, h: 0x22,
	i: 0x17, j: 0x23, k: 0x24, l: 0x25, m: 0x2f, n: 0x2e, o: 0x18, p: 0x19,
	q: 0x10, r: 0x13, s: 0x1e, t: 0x14, u: 0x16, v: 0x2c, w: 0x11, x: 0x2a,
	y: 0x15, z: 0x29,
};

// KEYS="3000:ret,9000:ret" - at 3s and 9s after startup, tap Return.
// A step may hold several keys: "5000:ret+space". Codes may also be given
// as raw hex, e.g. "5000:0x1c".
function parseKeyScript(spec) {
	if (!spec) return [];
	return spec.split(',').map((step) => {
		const [at, keys] = step.split(':');
		return {
			at: Number(at),
			codes: (keys || '').split('+').map((k) => {
				const name = k.trim().toLowerCase();
				if (name in KEYS) return KEYS[name];
				const v = Number(name);
                                if (!Number.isFinite(v)) throw new Error('unknown key: ' + k);
				return v;
			}),
		};
	});
}

const mountArgs = [];
let mod = null;
let crashed = null;

process.on('uncaughtException', (e) => {
  crashed = e;
  console.log('!! EXCEPTION: ' + e.message);
  console.log(String(e.stack).split('\n').slice(1, 10).join('\n'));
  process.exit(3);
});

// Minimal PNG writer: RGB8, no filtering. Enough to eyeball a screenshot.
function writePng(file, width, height, rgb) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// scrnmng.pc98surf is the composited PC-98 screen in RGB565 for this build.
function dumpScreen(M, file) {
  const ptr = M.ccall('np2probe_screen', 'number', [], []);
  if (!ptr) return null;
  const w = M.ccall('np2probe_screen_width', 'number', [], []);
  const h = M.ccall('np2probe_screen_height', 'number', [], []);
  const bpp = M.ccall('np2probe_screen_bpp', 'number', [], []);
  const pitch = M.ccall('np2probe_screen_pitch', 'number', [], []) || w * (bpp / 8);
  const heap = M.HEAPU8;
  const rgb = Buffer.alloc(w * h * 3);
  let nonBlack = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (bpp === 16) {
        const o = ptr + y * pitch + x * 2;
        const v = heap[o] | (heap[o + 1] << 8);
        r = ((v >> 11) & 0x1f) * 255 / 31;
        g = ((v >> 5) & 0x3f) * 255 / 63;
        b = (v & 0x1f) * 255 / 31;
      } else {
        const o = ptr + y * pitch + x * 4;
        b = heap[o]; g = heap[o + 1]; r = heap[o + 2];
      }
      const d = (y * w + x) * 3;
      rgb[d] = r | 0; rgb[d + 1] = g | 0; rgb[d + 2] = b | 0;
      if (r > 8 || g > 8 || b > 8) nonBlack++;
    }
  }
  writePng(file, w, h, rgb);
  return { w, h, bpp, pitch, nonBlack, pct: (nonBlack * 100 / (w * h)).toFixed(1) };
}

// PC-98 text VRAM: 16-bit character code per cell at even offsets, 80 columns.
// An ANK (single byte) character sits in the low byte with a zero high byte; a
// kanji is a two-byte JIS code, rendered here as a placeholder.
function dumpText(M, rows) {
  const base = M.ccall('np2probe_textvram', 'number', [], []);
  const heap = M.HEAPU8;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < 80; x++) {
      const off = base + (y * 80 + x) * 2;
      const lo = heap[off], hi = heap[off + 1];
      if (hi === 0) {
        line += (lo >= 0x20 && lo <= 0x7e) ? String.fromCharCode(lo)
              : (lo === 0 ? ' ' : '.');
      } else {
        line += '@';   // kanji / graphics cell
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

createNP2({
  arguments: mountArgs,
  preRun: [function (M) {
    M.ENV.SDL_VIDEODRIVER = 'dummy';
    M.ENV.SDL_AUDIODRIVER = 'emscripten';
    M.FS.writeFile('/np2kai.cfg', cfg);
    if (fontRom) M.FS.writeFile('/font.rom', fs.readFileSync(fontRom));
    const bios = process.env.BIOS_DIR || '';
    if (bios) {
      for (const n of ['2608_bd.wav','2608_sd.wav','2608_top.wav',
                       '2608_hh.wav','2608_tom.wav','2608_rim.wav']) {
        const f = path.join(bios, n);
        if (fs.existsSync(f)) {
          const b = fs.readFileSync(f);
          M.FS.writeFile('/' + n, b);
          M.FS.writeFile('/' + n.toUpperCase(), b);
        }
      }
    }
    M.FS.mkdir('/disk');
    images.forEach((p) => {
      const name = '/disk/' + path.basename(p);
      M.FS.writeFile(name, fs.readFileSync(p));
      mountArgs.push(name);
      console.log('mounted ' + name + ' (' + fs.statSync(p).size + ' bytes)');
    });
  }],
  print: (t) => console.log('[out] ' + t),
  printErr: (t) => console.log('[err] ' + t),
}).then((M) => {
  mod = M;
  const script = parseKeyScript(process.env.KEYS);
  for (const step of script) {
    setTimeout(() => {
      for (const code of step.codes) M.ccall('np2probe_key', null, ['number', 'number'], [code, 1]);
      setTimeout(() => {
        for (const code of step.codes) M.ccall('np2probe_key', null, ['number', 'number'], [code, 0]);
      }, Number(process.env.KEY_HOLD || 80));
      console.log('key @' + step.at + 'ms: ' + step.codes.map((c) => '0x' + c.toString(16)).join('+'));
    }, step.at);
  }
  if (process.env.WAV) {
    // Give the guest a moment to get going, then record the rest of the run.
    setTimeout(() => {
      const ok = M.ccall('np2probe_recstart', 'number', ['string'], ['/rec.wav']);
      console.log('recstart -> ' + ok);
    }, Number(process.env.WAV_DELAY || 2000));
  }
})
  .catch((e) => { crashed = e; console.log('!! MODULE REJECTED: ' + e.message); });

setTimeout(() => {
  if (crashed) { console.log('RESULT: crashed'); process.exit(3); }
  if (!mod) { console.log('RESULT: module never initialized'); process.exit(3); }
  console.log('--- text VRAM after ' + seconds + 's ' + '-'.repeat(56));
  const lines = dumpText(mod, 25);
  lines.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l));
  console.log('-'.repeat(80));
  for (const n of ['2608_bd.wav', '2608_BD.WAV']) {
    const pp = mod.ccall('np2probe_biosresolve', 'string', ['string'], [n]);
    const ok = mod.ccall('np2probe_canopen', 'number', ['string'], [n]);
    console.log('biospath resolve ' + n + ' -> "' + pp + '" openable=' + ok);
  }
  // EGC: egc_reset() leaves these defaults, so anything else means the
  // guest drove the blitter. vramop bit 1 is VOPBIT_EGC.
  const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(4, '0');
  const egc = {
    access: mod.ccall('np2probe_egc_access', 'number', [], []),
    fgbg: mod.ccall('np2probe_egc_fgbg', 'number', [], []),
    ope: mod.ccall('np2probe_egc_ope', 'number', [], []),
    mask: mod.ccall('np2probe_egc_mask', 'number', [], []),
    leng: mod.ccall('np2probe_egc_leng', 'number', [], []),
    sft: mod.ccall('np2probe_egc_sft', 'number', [], []),
  };
  const defaults = { access: 0xfff0, fgbg: 0x00ff, ope: 0, mask: 0xffff,
                     leng: 0x000f, sft: 0 };
  const touched = Object.keys(defaults).filter((k) => egc[k] !== defaults[k]);
  const vramop = mod.ccall('np2probe_vramop', 'number', [], []);
  console.log('grcg.chip=' + mod.ccall('np2probe_grcg_chip', 'number', [], [])
              + ' (3=EGC)  vramop=' + hex(vramop)
              + ' EGC mode ' + ((vramop & 2) ? 'ON' : 'off'));
  console.log('EGC regs ' + Object.entries(egc).map(([k, v]) => k + '=' + hex(v)).join(' '));
  console.log(touched.length
    ? 'EGC: guest wrote ' + touched.join(', ') + ' -> blitter in use'
    : 'EGC: all registers still at reset defaults -> not used in this run');
  const caps = mod.ccall('np2probe_rhythmcaps', 'number', [], []);
  console.log('rhythm samples loaded: 0x' + caps.toString(16)
              + (caps === 0x3f ? ' (all six)' : caps === 0 ? ' (none)' : ' (partial)'));
  const wav = process.env.WAV || '';
  if (wav) {
    mod.ccall('np2probe_recstop', null, [], []);
    try {
      const data = mod.FS.readFile('/rec.wav');
      fs.writeFileSync(wav, Buffer.from(data));
      const pcm = Buffer.from(data.buffer, data.byteOffset + 44, data.length - 44);
      let peak = 0, sum = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const v = Math.abs(pcm.readInt16LE(i));
        if (v > peak) peak = v;
        sum += v;
      }
      const n = pcm.length / 2;
      console.log('wav ' + data.length + ' bytes (' + (n / 2 / 44100).toFixed(2) + 's stereo)'
                  + ' peak=' + peak + ' mean=' + (sum / n).toFixed(1) + ' -> ' + wav);
    } catch (e) {
      console.log('wav: could not read /rec.wav: ' + e.message);
    }
  }
  const shot = process.env.SHOT || '';
  if (shot) {
    const info = dumpScreen(mod, shot);
    if (info) {
      console.log('screen ' + info.w + 'x' + info.h + ' ' + info.bpp + 'bpp pitch=' + info.pitch
                  + ' non-black ' + info.pct + '% -> ' + shot);
    } else {
      console.log('screen: pc98surf is null');
    }
  }
  console.log(lines.length ? 'RESULT: ran with no trap, ' + lines.length + ' non-empty text rows'
                           : 'RESULT: ran with no trap, text VRAM blank (graphics mode?)');
  process.exit(0);
}, seconds * 1000);
