// Shared, monotonically increasing z-index counter for all WinBox windows.
// Each new window calls nextZIndex() to get a value guaranteed higher than
// any existing window, so it always spawns on top.
//
// Also tracks open windows by key for deduplication: if a window with the
// same key is already open, focusIfExists() brings it to the front instead
// of creating a duplicate. This prevents the "I clicked 5 times and got 5
// copies of the same window" problem.
//
// CRITICAL — WinBox onclose semantics are INVERTED from convention:
//   `WinBox.prototype.close()` does:
//     if (this.onclose && this.onclose(force)) {
//         return true;            // early return — does NOT unmount
//     }
//     // ... unmount + remove from DOM
//   That is: onclose returning TRUTHY cancels the close. Returning FALSY
//   (undefined, false, null, 0, '') proceeds with unmount. This is the
//   opposite of what one normally expects from a callback named "onclose".
//
//   The bug we hit: returning `true` from onclose (which feels correct)
//   causes the X button to appear non-functional because WinBox never
//   tears down the window. Always return falsy. registerWindow() enforces
//   this for you.

let _zCounter = 10000
const _openWindows = new Map() // key -> WinBox instance

export function nextZIndex() {
  _zCounter += 1
  return _zCounter
}

// Register a window under a dedup key. If the caller passes an `onClose`
// callback (which must NOT return anything truthy), it's wrapped so:
//   - the dedup map entry is removed when the window closes
//   - the wrapper returns false unconditionally so WinBox actually unmounts
//
// The WinBox constructor should be called BEFORE registerWindow. The
// caller's `wb.onclose` should be set to the wrapper this function returns.
export function registerWindow(key, wb, onClose) {
  // If a window with this key already exists, close it first (replace).
  const existing = _openWindows.get(key)
  if (existing) {
    try { existing.close(true) } catch {}
  }
  _openWindows.set(key, wb)
  // Build a wrapper. Critical: this returns FALSY so WinBox unmounts.
  wb.onclose = (force) => {
    if (_openWindows.get(key) === wb) _openWindows.delete(key)
    try {
      if (typeof onClose === 'function') onClose(force)
    } catch {}
    return false
  }
}

// If a window with this key is already open, focus it (bring to front)
// and return true. Otherwise return false so the caller can open a new one.
export function focusIfExists(key) {
  const wb = _openWindows.get(key)
  if (!wb) return false
  try {
    // Bump z-index to bring it to the front.
    const z = String(nextZIndex())
    if (wb.dom && wb.dom.style) wb.dom.style.zIndex = z
    if (typeof wb.focus === 'function') wb.focus()
    else if (wb.dom) wb.dom.classList.add('focus')
  } catch {}
  return true
}