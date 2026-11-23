"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { SCRIPT } = require("../lib/chat-media-widget");

function harness() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      style: {}, listeners: {}, hidden: false,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
      },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute() {}, removeAttribute() {}, pause() {},
      play: () => Promise.resolve(), querySelector: () => element(),
    };
  }
  const document = { ...element(), getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }};
  const pending = [];
  const window = { ...element(), MediaRecorder: function () {} };
  vm.runInNewContext(SCRIPT, {
    window, document, navigator: { mediaDevices: { getUserMedia: () =>
      new Promise((resolve) => pending.push(resolve)) } },
    MEDIA_UPLOADS_ENABLED: true, CID: "test", COLLECT_LEADS: false, sending: false,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  return { elements, pending, window, document, open() {
    elements.get("camMenu").listeners.click({ target: { closest: () => ({ getAttribute: () => "photo" }) } });
  }};
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function stream() {
  let stopped = 0;
  return { getTracks: () => [{ stop: () => stopped++ }], get stopped() { return stopped; } };
}

test("closing while permission is pending releases the late camera stream", async () => {
  const h = harness(); h.open();
  h.elements.get("capClose").onclick();
  const s = stream(); h.pending[0](s); await flush();
  assert.equal(s.stopped, 1);
  assert.equal(h.elements.get("capLive").srcObject, null);
  assert.equal(h.elements.get("capMode").classList.contains("on"), false);
});

test("camera switch ignores an older permission response", async () => {
  const h = harness(); h.open(); h.elements.get("capFlip").onclick();
  const old = stream(), current = stream();
  h.pending[1](current); await flush(); h.pending[0](old); await flush();
  assert.equal(old.stopped, 1);
  assert.equal(h.elements.get("capLive").srcObject, current);
  h.window.__agentlyCloseCapture();
  assert.equal(current.stopped, 1);
});

test("hiding the page releases camera and closes capture", async () => {
  const h = harness(); h.open(); const s = stream(); h.pending[0](s); await flush();
  h.document.hidden = true; h.document.listeners.visibilitychange();
  assert.equal(s.stopped, 1);
  assert.equal(h.elements.get("capMode").classList.contains("on"), false);
});
