const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Target {
    constructor() { this.listeners = {}; this.style = {}; this.attrs = {}; this.captured = new Set(); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, values = {}) {
        const event = { type, target: this, pointerId: 1, button: 0, isPrimary: true, clientX: 350, clientY: 300, detail: 1, prevented: false,
            stopPropagation() {}, preventDefault() { this.prevented = true; }, ...values };
        for (const fn of this.listeners[type] || []) fn(event);
        return event;
    }
    setAttribute(name, value) { this.attrs[name] = value; }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); this.fire('lostpointercapture', { pointerId: id }); }
    focus() { this.focused = true; }
}

function harness(source) {
    const orb = new Target(), panel = new Target(), close = new Target(), hide = new Target(), checkbox = new Target(), wrap = new Target();
    const doc = new Target(), win = new Target();
    const nodes = { '#nm-orb': orb, '#nm-panel': panel, '#nm-close-panel': close, '#nm-hide-orb': hide };
    wrap.querySelector = selector => nodes[selector];
    wrap.offsetWidth = 42; wrap.offsetHeight = 42;
    wrap.getBoundingClientRect = () => ({ left: parseFloat(wrap.style.left) || 328, top: parseFloat(wrap.style.top) || 280, width: 42, height: 42 });
    wrap.contains = node => node === wrap || Object.values(nodes).includes(node);
    orb.getBoundingClientRect = wrap.getBoundingClientRect;
    panel.getBoundingClientRect = () => ({ width: 330, height: 480 });
    doc.querySelector = selector => selector === '#nm-set-show-orb' ? checkbox : null;
    win.innerWidth = 390; win.innerHeight = 700;
    let saves = 0;
    const settings = {};
    const context = {
        extensionSettings: settings, saveSettingsDebounced: () => saves++, eventSource: {}, eventTypes: {},
    };
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context },
        document: doc, window: win, controlWrap: wrap, URL, AbortSignal, console,
    });
    vm.runInContext(source.replace(/init\(\)\.catch\(.*\);\s*$/, ''), sandbox);
    vm.runInContext('$wrap = controlWrap; toast = () => {}; makeDraggable();', sandbox);
    return { orb, panel, close, hide, checkbox, wrap, doc, win, settings, run: code => vm.runInContext(code, sandbox), saves: () => saves };
}

const legacyPath = path.resolve(__dirname, '../../scratch/previous-index.js');
if (fs.existsSync(legacyPath)) {
    const old = harness(fs.readFileSync(legacyPath, 'utf8'));
    old.panel.style.display = 'block';
    old.orb.fire('touchstart', { touches: [{ clientX: 350, clientY: 300 }] });
    old.orb.fire('touchend');
    assert.equal(old.panel.style.display, 'none');
    old.orb.fire('click');
    assert.equal(old.panel.style.display, 'block', 'legacy mobile click reopened the just-closed panel');
    console.log('REPRODUCED: old touchend + compatibility click leaves the panel open');
}

const current = harness(fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8'));
const { orb, panel, doc, win } = current;
function tap(pointerType = 'touch') {
    orb.fire('pointerdown', { pointerType });
    orb.fire('pointerup', { pointerType });
    orb.fire('click', { pointerType });
}
tap();
assert.equal(panel.style.display, 'block');
assert.equal(orb.attrs['aria-expanded'], 'true');
assert(parseFloat(panel.style.left) >= 12 && parseFloat(panel.style.left) + 330 <= win.innerWidth - 12);
assert(parseFloat(panel.style.top) >= 12 && parseFloat(panel.style.top) + 480 <= win.innerHeight - 12);
tap();
assert.equal(panel.style.display, 'none');
assert.equal(orb.attrs['aria-expanded'], 'false');
assert.equal(orb.listeners.touchend, undefined, 'no second touch toggle');
tap('mouse');
assert.equal(panel.style.display, 'block');
orb.fire('pointerdown', { pointerType: 'mouse' });
orb.fire('pointermove', { clientX: 290, clientY: 330 });
orb.fire('pointerup');
const draggedClick = orb.fire('click');
assert.equal(draggedClick.prevented, true);
assert.equal(panel.style.display, 'block', 'drag must not toggle');
assert.equal(current.wrap.style.right, 'auto');
tap();
assert.equal(panel.style.display, 'none', 'a fresh tap works after dragging');
orb.fire('click', { detail: 0 });
assert.equal(panel.style.display, 'block', 'keyboard activation opens panel');
current.close.fire('click');
assert.equal(panel.style.display, 'none');
assert.equal(orb.focused, true);
tap();
doc.fire('click', { target: {} });
assert.equal(panel.style.display, 'none', 'outside click closes');
tap();
doc.fire('click', { target: panel });
assert.equal(panel.style.display, 'block', 'inside click does not close');
const escape = doc.fire('keydown', { key: 'Escape' });
assert.equal(panel.style.display, 'none');
assert.equal(escape.prevented, true);
tap();
current.hide.fire('click');
assert.equal(panel.style.display, 'none');
assert.equal(current.wrap.style.display, 'none');
assert.equal(current.settings.netease_music.showOrb, false);
assert.equal(current.checkbox.checked, false);
const afterHide = current.saves();
current.run('setOrbVisible(true)');
assert.equal(current.wrap.style.display, '');
assert.equal(current.checkbox.checked, true);
assert.equal(current.settings.netease_music.showOrb, true);
assert(current.saves() > afterHide, 'visibility preference is saved');
orb.fire('pointerdown');
orb.fire('pointercancel');
tap();
assert.equal(panel.style.display, 'block', 'next tap works after cancellation');
assert.equal(orb.captured.size, 0);
orb.fire('pointerdown', { isPrimary: false, pointerId: 2 });
orb.fire('pointermove', { isPrimary: false, pointerId: 2, clientX: 10 });
assert.equal(panel.style.display, 'block', 'secondary touches do not change panel state');
win.fire('resize');
assert(parseFloat(panel.style.left) >= 12);
console.log('PASS: mobile and desktop taps, drag suppression, keyboard, cancellation, close, outside click, Escape, saved hide/show, and viewport placement');

