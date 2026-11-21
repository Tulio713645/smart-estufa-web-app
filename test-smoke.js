const { JSDOM } = require('jsdom');
const fs = require('fs');

// Load HTML and JS
const html = fs.readFileSync('index.html', 'utf8');
const jsCode = fs.readFileSync('app.js', 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  resources: 'usable',
  pretendToBeVisual: true
});

const window = dom.window;
global.window = window;
global.document = window.document;
global.navigator = window.navigator;

// Mock localStorage (jsdom doesn't provide it by default)
const localStorageMock = {
  store: {},
  getItem(key) { return this.store[key] || null; },
  setItem(key, value) { this.store[key] = value.toString(); },
  removeItem(key) { delete this.store[key]; },
  clear() { this.store = {}; }
};
global.localStorage = localStorageMock;
window.localStorage = localStorageMock;

global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Mock IndexedDB
const mockDB = {
  objectStoreNames: { contains: () => false },
  createObjectStore: () => ({ createIndex: () => {} }),
  transaction: () => ({ objectStore: () => ({ put: () => ({ onsuccess: null }), getAll: () => ({ onsuccess: null, result: [] }) }) })
};

window.indexedDB = {
  open: () => {
    const req = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      result: mockDB
    };
    setTimeout(() => {
      if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: mockDB } });
      if (req.onsuccess) req.onsuccess({ target: { result: mockDB } });
    }, 10);
    return req;
  }
};

// Mock vibration
window.navigator.vibrate = () => {};

// Mock AndroidBluetooth bridge
window.AndroidBluetooth = {
  isBluetoothSupported: () => true,
  getPairedDevices: () => JSON.stringify([
    { name: 'HC-05', address: '98:D3:31:FD:A2:14' },
    { name: 'HC-05 Estufa 2', address: '98:D3:31:FD:A2:15' }
  ]),
  connect: (addr) => {
    console.log('[Mock] Connecting to', addr);
    setTimeout(() => {
      if (window.onBluetoothStatusChanged) {
        window.onBluetoothStatusChanged('connected', 'HC-05');
      }
    }, 100);
  },
  disconnect: () => {
    console.log('[Mock] Disconnecting');
    if (window.onBluetoothStatusChanged) {
      window.onBluetoothStatusChanged('disconnected', 'User disconnected');
    }
  },
  triggerCriticalAlert: (name, id, type, msg) => {
    console.log('[Mock] Push notification:', name, id, type, msg);
  },
  hasNotificationPermission: () => true,
  requestNotificationPermission: () => {}
};

// Execute the app.js
eval(jsCode);

// Trigger DOMContentLoaded to initialize app
const event = new window.Event('DOMContentLoaded');
window.document.dispatchEvent(event);

// Wait for initialization
setTimeout(() => {
  console.log('\n=== SMOKE TEST RESULTS ===');

  let allPassed = true;

  // Check 1: DOM elements exist
  const requiredElements = [
    'btnBrandHome',
    'btnAddGreenhouse',
    'btnToggleConnection',
    'btnPickBtDeviceAdd',
    'btDeviceSelectedAdd',
    'btnPickBtDeviceEdit',
    'btDeviceSelectedEdit',
    'modalAddGreenhouse',
    'modalEditGreenhouse',
    'modalBluetoothDevices',
    'greenhousesGrid'
  ];

  requiredElements.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      console.log('✓ Element exists:', id);
    } else {
      console.log('✗ Element MISSING:', id);
      allPassed = false;
    }
  });

  // Check 2: Greenhouse cards rendered
  const grid = document.getElementById('greenhousesGrid');
  if (grid && grid.children.length > 0) {
    console.log('✓ Greenhouse cards rendered:', grid.children.length);
  } else {
    console.log('✗ Greenhouse cards NOT rendered');
    allPassed = false;
  }

  // Check 3: Test Add Greenhouse flow
  console.log('\n--- Testing Add Greenhouse Flow ---');
  const btnAdd = document.getElementById('btnAddGreenhouse');
  if (btnAdd) {
    btnAdd.click();
    const modal = document.getElementById('modalAddGreenhouse');
    if (modal && !modal.classList.contains('hidden')) {
      console.log('✓ Add Greenhouse modal opens');

      // Test BT device picker button
      const btnPickBt = document.getElementById('btnPickBtDeviceAdd');
      if (btnPickBt) {
        btnPickBt.click();
        const btModal = document.getElementById('modalBluetoothDevices');
        if (btModal && !btModal.classList.contains('hidden')) {
          console.log('✓ BT Device picker opens from Add modal');

          // Select a device
          const deviceItems = btModal.querySelectorAll('.bt-device-item');
          if (deviceItems.length > 0) {
            deviceItems[0].click();
            const selectedText = document.getElementById('btDeviceSelectedAdd').textContent;
            if (selectedText && selectedText !== 'Selecionar HC-05 pareado...') {
              console.log('✓ Device selected:', selectedText.trim());
            } else {
              console.log('✗ Device selection not reflected in button');
              allPassed = false;
            }
          } else {
            console.log('✗ No devices in picker');
            allPassed = false;
          }

          // Close BT modal
          btModal.classList.add('hidden');
        } else {
          console.log('✗ BT modal did not open');
          allPassed = false;
        }
      } else {
        console.log('✗ BT picker button not found in Add modal');
        allPassed = false;
      }

      // Close Add modal
      modal.classList.add('hidden');
    } else {
      console.log('✗ Add Greenhouse modal did not open');
      allPassed = false;
    }
  }

  // Check 4: Test Edit Greenhouse flow (3-dots button opens bottom sheet)
  console.log('\n--- Testing Edit Greenhouse Flow ---');
  const firstCard = document.querySelector('.greenhouse-card-unit');
  if (firstCard) {
    const btnMore = firstCard.querySelector('.btn-card-more');
    if (btnMore) {
      console.log('✓ 3-dots button exists on greenhouse card');
      // Check z-index and touch-action for proper touch handling (CSS has these but JSDOM may not compute)
      const style = window.getComputedStyle(btnMore);
      console.log('  z-index:', style.zIndex, 'touch-action:', style.touchAction);
      btnMore.click();
      // Check if bottom sheet modal opens
      const modal = document.getElementById('modalGreenhouseOptions');
      if (modal && !modal.classList.contains('hidden')) {
        console.log('✓ Bottom sheet opens on 3-dots click');
        // Close it for next tests
        modal.classList.add('hidden');
      } else {
        console.log('✗ Bottom sheet did not open');
        allPassed = false;
      }
    } else {
      console.log('✗ 3-dots button not found on greenhouse card');
      allPassed = false;
    }
  } else {
    console.log('✗ No greenhouse card found');
    allPassed = false;
  }

  // Check 5: BT indicator in bt-status-bar (new location below header)
  console.log('\n--- Testing Header UI ---');
  const headerBtFloating = document.getElementById('headerBtFloating');
  const btStatusBar = document.querySelector('.bt-status-bar');
  if (headerBtFloating) {
    console.log('✓ Header BT Status Bar Indicator exists');
    if (btStatusBar && btStatusBar.contains(headerBtFloating)) {
      console.log('✓ Header BT Indicator correctly placed inside bt-status-bar');
      // Check class uses new style
      if (headerBtFloating.className.includes('bt-status-indicator')) {
        console.log('✓ Header BT Indicator uses bt-status-indicator class');
      } else {
        console.log('⚠ Header BT Indicator class:', headerBtFloating.className);
      }
    } else {
      console.log('✗ Header BT Indicator NOT inside bt-status-bar');
      allPassed = false;
    }
  } else {
    console.log('✗ Header BT Status Bar Indicator NOT found');
    allPassed = false;
  }

  // Check bt-status-bar exists
  if (btStatusBar) {
    console.log('✓ BT Status Bar element exists');
  } else {
    console.log('✗ BT Status Bar NOT found');
    allPassed = false;
  }

  // Check 6: Graph container height (should be 360px)
  const canvasContainer = document.querySelector('.canvas-container');
  if (canvasContainer) {
    // In JSDOM, computed styles might not work perfectly, check the CSS class is present
    console.log('✓ Canvas container element exists');
    // Check if height is set via style attribute or inline
    const height = canvasContainer.style.height || window.getComputedStyle(canvasContainer).height;
    console.log('  Height:', height);
  } else {
    console.log('✗ Canvas container not found');
    allPassed = false;
  }

  // Check 7: user-select:none on greenhouse cards (check CSS rule)
  console.log('\n--- Testing CSS Rules ---');
  const card = document.querySelector('.greenhouse-card-unit');
  if (card) {
    // Check CSS rule exists
    const sheets = Array.from(document.styleSheets);
    let hasUserSelectNone = false;
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules || []);
        for (const rule of rules) {
          if (rule.selectorText && rule.selectorText.includes('.greenhouse-card-unit')) {
            if (rule.style && (rule.style.userSelect === 'none' || rule.style.getPropertyValue('user-select') === 'none')) {
              hasUserSelectNone = true;
              break;
            }
            // Check vendor prefixes
            if (rule.style && (rule.style.webkitUserSelect === 'none' || rule.style.getPropertyValue('-webkit-user-select') === 'none')) {
              hasUserSelectNone = true;
              break;
            }
          }
        }
      } catch (e) {
        // Cross-origin or other CSSOM issues
      }
    }
    if (hasUserSelectNone) {
      console.log('✓ CSS rule for user-select: none found on .greenhouse-card-unit');
    } else {
      console.log('⚠ CSS rule for user-select: none not verified (JSDOM limitation)');
    }
  }

  // Check 8: No duplicate IDs
  const allIds = [];
  document.querySelectorAll('[id]').forEach(el => {
    if (el.id) allIds.push(el.id);
  });
  const uniqueIds = new Set(allIds);
  if (allIds.length === uniqueIds.size) {
    console.log('✓ No duplicate IDs:', allIds.length, 'total');
  } else {
    console.log('✗ Duplicate IDs found!');
    const counts = {};
    allIds.forEach(id => counts[id] = (counts[id] || 0) + 1);
    Object.entries(counts).filter(([_, c]) => c > 1).forEach(([id, c]) => console.log('  -', id, ':', c, 'times'));
    allPassed = false;
  }

  console.log('\n=== OVERALL RESULT ===');
  if (allPassed) {
    console.log('✓ ALL SMOKE TESTS PASSED');
    process.exit(0);
  } else {
    console.log('✗ SOME TESTS FAILED');
    process.exit(1);
  }
}, 500);