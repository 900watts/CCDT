// Shared, monotonically increasing z-index counter for all WinBox windows.
// Each new window calls nextZIndex() to get a value that's guaranteed
// higher than any existing window, so it always spawns on top.
//
// Also tracks open windows by key for deduplication: if a window with the
// same key is already open, focusOrOpen() brings it to the front instead
// of creating a duplicate. This prevents the "I clicked 5 times and got 5
// copies of the same window" problem.

let _zCounter = 10000
const _openWindows = new Map() // key -> WinBox instance

export function nextZIndex() {
  _zCounter += 1
  return _zCounter
}

// Register a window under a dedup key. Called when a new window is created.
export function registerWindow(key, wb) {
  // If a window with this key already exists, close it first (replace).
  const existing = _openWindows.get(key)
  if (existing) {
    try { existing.close(true) } catch {}
  }
  _openWindows.set(key, wb)
  // Auto-remove from the map when the window closes.
  const origClose = wb.close.bind(wb)
  wb.close = function (...args) {
    if (_openWindows.get(key) === wb) _openWindows.delete(key)
    return origClose(...args)
  }
}

// If a window with this key is already open, focus it (bring to front)
// and return true. Otherwise return false so the caller can open a new one.
export function focusIfExists(key) {
  const wb = _openWindows.get(key)
  if (!wb) return false
  try {
    // Bump z-index to bring it to the front.
    wb.g.root.style.zIndex = String(nextZIndex())
    // WinBox focus also calls onfocus and sets the class.
    if (typeof wb.focus === 'function') wb.focus()
    else if (wb.g && wb.g.root) wb.g.root.classList.add('focus')
  } catch {}
  return true
}