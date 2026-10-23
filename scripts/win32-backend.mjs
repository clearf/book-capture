/**
 * Book Capture — Windows backend
 *
 * Win32 equivalents of the macOS helpers in book-capture-utils.mjs, called via
 * koffi FFI so each page costs no extra process spawn:
 * - Window lookup by owning process (CGWindowList → FindWindowEx walk)
 * - Focus + keystrokes (AppleScript System Events → SetForegroundWindow + keybd_event)
 * - Window capture (screencapture -l → PrintWindow into a 32bpp DIB)
 * - Keep-awake (caffeinate → SetThreadExecutionState)
 *
 * Imported lazily by book-capture-utils.mjs only when process.platform is win32.
 * Callers never import this directly.
 */

import koffi from 'koffi';
import path from 'path';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
  biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32',
});

// HWND/HDC/HBITMAP are declared as uintptr_t so they round-trip through JS as plain numbers.
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)');
const FindWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, void *cls, void *title)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hwnd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ RECT *rect)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uintptr_t hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(uintptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int cmd)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(uintptr_t hwnd, uintptr_t hdc, uint32_t flags)');
const GetDC = user32.func('uintptr_t __stdcall GetDC(uintptr_t hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(uintptr_t hwnd, uintptr_t hdc)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');

const CreateCompatibleDC = gdi32.func('uintptr_t __stdcall CreateCompatibleDC(uintptr_t hdc)');
const CreateCompatibleBitmap = gdi32.func('uintptr_t __stdcall CreateCompatibleBitmap(uintptr_t hdc, int w, int h)');
const SelectObject = gdi32.func('uintptr_t __stdcall SelectObject(uintptr_t hdc, uintptr_t obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(uintptr_t obj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(uintptr_t hdc)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(uintptr_t hdc, uintptr_t hbm, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ BITMAPINFOHEADER *bmi, uint32_t usage)');

const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(uintptr_t proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
const SetThreadExecutionState = kernel32.func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)');

// Per-monitor DPI awareness: window rects, cursor positions and captures are all
// in physical pixels, so a 150%-scaled display does not get cropped or blurred.
SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PW_RENDERFULLCONTENT = 0x2; // needed for DirectComposition/WebView2 content (both Kindle apps)
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;

function wideToString(buf, len) {
  return Buffer.from(buf.buffer, buf.byteOffset, len * 2).toString('utf16le');
}

function processImagePath(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    return QueryFullProcessImageNameW(h, 0, buf, size) ? wideToString(buf, size[0]) : '';
  } finally {
    CloseHandle(h);
  }
}

function windowRect(hwnd) {
  const r = {};
  GetWindowRect(hwnd, r);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/**
 * Visible top-level windows whose owning process name matches `ownerPattern`.
 * "Owner" is the exe name without .exe (Kindle.exe → "Kindle"), mirroring
 * kCGWindowOwnerName on macOS. Matching is bidirectional substring so the macOS
 * app name "Amazon Kindle" still finds Kindle.exe.
 */
function findWindows(ownerPattern, exact = false) {
  const want = ownerPattern.toLowerCase();
  const found = [];
  let hwnd = 0;
  while ((hwnd = FindWindowExW(0, hwnd, null, null))) {
    if (!IsWindowVisible(hwnd)) continue;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const exePath = processImagePath(pid[0]);
    const owner = path.win32.basename(exePath, '.exe').toLowerCase();
    if (!owner) continue;
    const match = exact ? owner === want : (owner.includes(want) || want.includes(owner));
    if (!match) continue;
    const bounds = windowRect(hwnd);
    if (bounds.width * bounds.height <= 10000) continue; // tooltips, helper windows
    const title = new Uint16Array(512);
    const titleLen = GetWindowTextW(hwnd, title, title.length);
    found.push({ hwnd, pid: pid[0], exePath, title: wideToString(title, titleLen), bounds });
  }
  return found.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
}

export function getWindowIdByOwner(ownerPattern, exact = false) {
  const windows = findWindows(ownerPattern, exact);
  if (windows.length === 0) {
    throw new Error(`No window found for "${ownerPattern}". Is the app open with a book visible?`);
  }
  const owners = new Set(windows.map(w => w.exePath));
  if (owners.size > 1) {
    // e.g. both the Store Kindle app and Legacy Kindle for PC are open
    console.log(`Warning: ${owners.size} "${ownerPattern}" apps are open; using the largest window (${windows[0].exePath}).`);
  }
  return String(windows[0].hwnd);
}

export function getWindowBounds(ownerPattern) {
  const [w] = findWindows(ownerPattern);
  return w ? w.bounds : null;
}

// The window activateApp last focused. sendKeystroke re-focuses it before each key,
// because on Windows a toast or a click elsewhere silently steals the keyboard and
// Page Down would then go to the wrong app for the rest of the run.
let targetHwnd = 0;

function focusWindow(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
  if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return true;
  // Foreground lock: borrow the current foreground thread's input state.
  const fgThread = GetWindowThreadProcessId(GetForegroundWindow(), [0]);
  const me = GetCurrentThreadId();
  AttachThreadInput(me, fgThread, true);
  try {
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
  } finally {
    AttachThreadInput(me, fgThread, false);
  }
  return GetForegroundWindow() === hwnd;
}

export function activateApp(appName) {
  const [w] = findWindows(appName);
  if (!w) throw new Error(`No window found for "${appName}". Is the app open?`);
  targetHwnd = w.hwnd;
  if (!focusWindow(w.hwnd)) {
    console.log(`Warning: could not bring "${appName}" to the front; click its window once.`);
  }
}

// Windows virtual-key codes, keyed like the macOS KEY_CODES table.
const VK = {
  'right arrow': [0x27, true],
  'left arrow': [0x25, true],
  'down arrow': [0x28, true],
  'up arrow': [0x26, true],
  'page down': [0x22, true],
  'page up': [0x21, true],
  'return': [0x0d, false],
  'space': [0x20, false],
  'escape': [0x1b, false],
};
const MOD_VK = { command: 0x11 /* Ctrl stands in for Cmd */, shift: 0x10, option: 0x12, control: 0x11 };

export function sendKeystroke(key, modifiers = {}) {
  const entry = VK[key.toLowerCase()];
  if (!entry) throw new Error(`Unknown key: ${key}`);
  const [vk, extended] = entry;
  if (targetHwnd && GetForegroundWindow() !== targetHwnd) focusWindow(targetHwnd);
  const mods = Object.keys(modifiers).filter(m => modifiers[m] && MOD_VK[m]).map(m => MOD_VK[m]);
  for (const m of mods) keybd_event(m, 0, 0, 0);
  const ext = extended ? KEYEVENTF_EXTENDEDKEY : 0;
  keybd_event(vk, 0, ext, 0);
  keybd_event(vk, 0, ext | KEYEVENTF_KEYUP, 0);
  for (const m of mods.reverse()) keybd_event(m, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * Capture a window's pixels with PrintWindow, which works even when the window is
 * partly covered by another one. Returns { data, width, height } as RGBA, ready for
 * sharp's raw input.
 */
export function captureWindowPixels(windowId) {
  const hwnd = Number(windowId);
  const { width, height } = windowRect(hwnd);
  if (width <= 0 || height <= 0) throw new Error(`Window ${windowId} has no area (minimized or closed?)`);

  const screenDC = GetDC(0);
  const memDC = CreateCompatibleDC(screenDC);
  const bitmap = CreateCompatibleBitmap(screenDC, width, height);
  const previous = SelectObject(memDC, bitmap);
  try {
    if (!PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT)) throw new Error(`PrintWindow failed for window ${windowId}`);
    const bmi = {
      biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, // negative = top-down rows
      biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0,
      biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    };
    const data = Buffer.alloc(width * height * 4);
    if (!GetDIBits(memDC, bitmap, 0, height, data, bmi, 0)) throw new Error('GetDIBits failed');
    // GDI hands back BGRA with an undefined alpha byte; sharp wants opaque RGBA.
    for (let i = 0; i < data.length; i += 4) {
      const b = data[i];
      data[i] = data[i + 2];
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    return { data, width, height };
  } finally {
    SelectObject(memDC, previous);
    DeleteObject(bitmap);
    DeleteDC(memDC);
    ReleaseDC(0, screenDC);
  }
}

/** Keep the display and system awake until this process exits (caffeinate equivalent). */
export function keepAwake() {
  SetThreadExecutionState(0x80000000 | 0x2 | 0x1); // ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
}
