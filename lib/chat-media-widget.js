"use strict";

/**
 * Camera, photo and video-clip capture for the public chat widget
 * (api/routes/widget.js). Kept in its own module so the browser code is
 * plain JavaScript rather than text inside widget.js's giant template
 * literal, and so a test can syntax-check it.
 *
 * The visitor can:
 *   - take a photo with the live camera (rear camera first on phones),
 *   - record a clip of up to 15 seconds (with sound),
 *   - pick a photo or clip from the device.
 * They see a preview, can add a note, then send. Photos are shrunk to JPEG in
 * the browser first (this also turns iPhone HEIC into something the server
 * reads). For clips, the browser grabs a few still frames for the AI, because
 * the server has no video decoder.
 *
 * If the live camera is unavailable (no permission, or a site embedded the
 * widget with an old iframe tag that does not allow the camera) the visitor is
 * offered the device's own camera / file picker, which needs no permission.
 *
 * Expects these to exist in the widget's scope: API, CID, COLLECT_LEADS,
 * history, msgs, currentLang, sending (var), addBotMsg, addMsg, saveSession,
 * showTyping, hideTyping, speakReply, renderLeadForm, leadAlreadyCaptured,
 * maybeTriggerLeadCapture.
 */

const CSS = `
#cam{background:#fff;border:1.5px solid #e2e8f0;color:#64748b;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all .2s;}
#cam:hover,#cam.on{border-color:var(--a);color:var(--a);background:var(--al)}
#cam:disabled{opacity:.45;cursor:not-allowed}
#camMenu{position:absolute;left:12px;bottom:70px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 10px 30px rgba(15,23,42,.14);display:none;flex-direction:column;padding:6px;z-index:6;min-width:210px;animation:fadeIn .15s ease-out}
#camMenu.on{display:flex}
#camMenu button{display:flex;align-items:center;gap:10px;padding:10px 12px;border:none;background:none;font-size:13px;font-weight:600;color:#1e293b;border-radius:10px;cursor:pointer;text-align:left;font-family:inherit}
#camMenu button:hover{background:#f1f5f9;color:var(--a)}
#camMenu svg{flex-shrink:0;color:var(--a)}
#capMode{position:absolute;inset:0;background:#0b1120;display:none;flex-direction:column;z-index:11;color:#fff}
#capMode.on{display:flex}
.capTop{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;gap:10px}
.capTitle{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7)}
.capIcon{width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}
.capIcon[hidden]{display:none}
.capStage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;min-height:0}
.capStage video,.capStage img{max-width:100%;max-height:100%;object-fit:contain;display:block}
#capMode [hidden]{display:none!important}
#capTimer{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(220,38,38,.92);color:#fff;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;font-variant-numeric:tabular-nums;display:none}
#capTimer.on{display:block}
.capMsg{padding:24px;text-align:center;font-size:13.5px;line-height:1.5;color:rgba(255,255,255,.85);display:flex;flex-direction:column;align-items:center;gap:14px}
.capBar{padding:12px 14px 16px;display:flex;flex-direction:column;gap:10px}
.capRow{display:flex;align-items:center;justify-content:center;gap:22px;min-height:66px}
#capShutter{width:64px;height:64px;border-radius:50%;border:4px solid #fff;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
#capShutter span{width:50px;height:50px;border-radius:50%;background:#fff;transition:all .2s}
#capShutter.video span{background:#dc2626}
#capShutter.rec span{width:24px;height:24px;border-radius:6px;background:#dc2626}
#capShutter:disabled{opacity:.4;cursor:not-allowed}
#capNote{width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:14px;font-family:inherit;outline:none}
#capNote::placeholder{color:rgba(255,255,255,.5)}
.capBtn{border:none;border-radius:999px;padding:11px 20px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.capBtn.ghost{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2)}
.capBtn.main{background:var(--a);color:#fff}
.capHint{font-size:11.5px;color:rgba(255,255,255,.5);text-align:center}
.bmedia{position:relative;display:block;margin-bottom:6px}
.bmedia img{display:block;max-width:200px;max-height:220px;border-radius:12px;object-fit:cover}
.bmedia .bplay{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px}
`;

const ICON_CAMERA =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_VIDEO =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>';
const ICON_UPLOAD =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>';
const ICON_FLIP =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h13a4 4 0 0 1 4 4v1"/><path d="m7 3-4 4 4 4"/><path d="M21 17H8a4 4 0 0 1-4-4v-1"/><path d="m17 21 4-4-4-4"/></svg>';
const ICON_CLOSE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/** Button that sits in the input row, before the mic. */
const BUTTON = `<button id="cam" type="button" aria-label="Send a photo or video" title="Photo or video" aria-haspopup="true" aria-expanded="false">${ICON_CAMERA}</button>`;

/** Menu + capture overlay; placed inside #cw. */
const MARKUP = `
<div id="camMenu" role="menu" aria-label="Send a photo or video">
  <button type="button" role="menuitem" data-act="photo">${ICON_CAMERA}<span>Take a photo</span></button>
  <button type="button" role="menuitem" data-act="video" id="camMenuVideo">${ICON_VIDEO}<span>Record a video (15s)</span></button>
  <button type="button" role="menuitem" data-act="upload">${ICON_UPLOAD}<span>Choose from device</span></button>
</div>
<input id="camFilePhoto" type="file" accept="image/*" capture="environment" hidden/>
<input id="camFileVideo" type="file" accept="video/*" capture="environment" hidden/>
<input id="camFileAny" type="file" accept="image/*,video/*" hidden/>
<div id="capMode" role="dialog" aria-label="Camera">
  <div class="capTop">
    <span class="capTitle" id="capTitle">Photo</span>
    <span style="display:flex;gap:8px">
      <button type="button" class="capIcon" id="capFlip" aria-label="Switch camera" title="Switch camera">${ICON_FLIP}</button>
      <button type="button" class="capIcon" id="capClose" aria-label="Close camera" title="Close">${ICON_CLOSE}</button>
    </span>
  </div>
  <div class="capStage">
    <video id="capLive" playsinline autoplay muted></video>
    <img id="capShot" alt="Your photo" hidden/>
    <video id="capClip" playsinline controls hidden></video>
    <div class="capMsg" id="capMsg" hidden></div>
    <div id="capTimer">0:00 / 0:15</div>
  </div>
  <div class="capBar">
    <div class="capRow" id="capLiveRow">
      <button type="button" id="capShutter" aria-label="Take photo"><span></span></button>
    </div>
    <div id="capReviewRow" hidden>
      <input id="capNote" type="text" maxlength="600" placeholder="Add a note (optional)" aria-label="Note"/>
      <div class="capRow" style="min-height:0;margin-top:10px">
        <button type="button" class="capBtn ghost" id="capRetake">Retake</button>
        <button type="button" class="capBtn main" id="capSend">Send</button>
      </div>
    </div>
    <div class="capHint" id="capHint">Your photo is only shared with this business.</div>
  </div>
</div>
`;

/*
 * Browser code. Plain ES5 to match the rest of the widget. It is injected
 * into the widget's IIFE, so it sees the widget's own functions and state.
 */
const SCRIPT = `
  /* ── Camera / photo / video clip (Front Desk port) ─────────── */
  (function setupMedia() {
    var MEDIA_ON = MEDIA_UPLOADS_ENABLED;
    var CLIP_MAX_MS = 15000;
    var PHOTO_MAX_EDGE = 1600;
    var FRAME_MAX_EDGE = 768;
    var MEDIA_TOKEN_KEY = 'agently:' + CID + ':mediaToken';
    var SID_KEY = 'agently:' + CID + ':mediaSid';

    var cam = document.getElementById('cam');
    var menu = document.getElementById('camMenu');
    var menuVideo = document.getElementById('camMenuVideo');
    var filePhoto = document.getElementById('camFilePhoto');
    var fileVideo = document.getElementById('camFileVideo');
    var fileAny = document.getElementById('camFileAny');
    var cap = document.getElementById('capMode');
    var capTitle = document.getElementById('capTitle');
    var capFlip = document.getElementById('capFlip');
    var capClose = document.getElementById('capClose');
    var live = document.getElementById('capLive');
    var shot = document.getElementById('capShot');
    var clip = document.getElementById('capClip');
    var capMsg = document.getElementById('capMsg');
    var timer = document.getElementById('capTimer');
    var liveRow = document.getElementById('capLiveRow');
    var shutter = document.getElementById('capShutter');
    var reviewRow = document.getElementById('capReviewRow');
    var note = document.getElementById('capNote');
    var retake = document.getElementById('capRetake');
    var sendBtn = document.getElementById('capSend');
    var hint = document.getElementById('capHint');

    if (!cam || !cap) return;
    if (!MEDIA_ON) { cam.style.display = 'none'; return; }

    var hasLiveCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var canRecord = hasLiveCam && typeof window.MediaRecorder !== 'undefined';
    if (!canRecord && menuVideo) {
      // No in-page recorder: the device's own camera app can still record.
      menuVideo.querySelector('span').textContent = 'Record a video';
    }

    var st = { mode: 'photo', facing: 'environment', stream: null, recorder: null, chunks: [],
               recStart: 0, tick: null, stopTimer: null, blob: null, kind: null,
               durationMs: 0, url: null, poster: null };

    /* ── identity for this visit ── */
    function randomId() {
      var b = new Uint8Array(16);
      try { (window.crypto || window.msCrypto).getRandomValues(b); }
      catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
      var s = '';
      for (var j = 0; j < b.length; j++) s += ('0' + b[j].toString(16)).slice(-2);
      return s;
    }
    function mediaSessionId() {
      try {
        var v = sessionStorage.getItem(SID_KEY);
        if (!v) { v = randomId(); sessionStorage.setItem(SID_KEY, v); }
        return v;
      } catch (e) {
        if (!st.memSid) st.memSid = randomId();
        return st.memSid;
      }
    }
    function mediaToken() {
      try { return localStorage.getItem(MEDIA_TOKEN_KEY) || sessionStorage.getItem(MEDIA_TOKEN_KEY) || ''; }
      catch (e) { return st.memToken || ''; }
    }
    window.__agentlySetMediaToken = function (t) {
      if (!t) return;
      st.memToken = t;
      try { localStorage.setItem(MEDIA_TOKEN_KEY, t); sessionStorage.setItem(MEDIA_TOKEN_KEY, t); } catch (e) {}
    };
    window.__agentlyMediaSessionId = mediaSessionId;

    /* ── menu ── */
    function setMenu(on) {
      menu.classList.toggle('on', on);
      cam.classList.toggle('on', on);
      cam.setAttribute('aria-expanded', String(on));
    }
    cam.onclick = function () {
      if (sending) return;
      if (COLLECT_LEADS && !leadAlreadyCaptured()) { renderLeadForm(); return; }
      setMenu(!menu.classList.contains('on'));
    };
    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('on')) return;
      if (e.target === cam || cam.contains(e.target) || menu.contains(e.target)) return;
      setMenu(false);
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b) return;
      setMenu(false);
      var act = b.getAttribute('data-act');
      if (act === 'upload') { fileAny.value = ''; fileAny.click(); return; }
      if (act === 'video' && !canRecord) { fileVideo.value = ''; fileVideo.click(); return; }
      if (act === 'photo' && !hasLiveCam) { filePhoto.value = ''; filePhoto.click(); return; }
      openCapture(act === 'video' ? 'video' : 'photo');
    });

    /* ── overlay state ── */
    function show(el, on) { if (el) el.hidden = !on; }
    function fmt(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return '0:' + (s < 10 ? '0' + s : s); }

    function stopStream() {
      if (st.stream) { try { st.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
      st.stream = null;
      try { live.srcObject = null; } catch (e) {}
    }
    function clearTimers() {
      if (st.tick) { clearInterval(st.tick); st.tick = null; }
      if (st.stopTimer) { clearTimeout(st.stopTimer); st.stopTimer = null; }
      timer.classList.remove('on');
    }
    function revokeUrl() { if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) {} st.url = null; } }

    function setLiveUI() {
      show(live, true); show(shot, false); show(clip, false); show(capMsg, false);
      show(liveRow, true); show(reviewRow, false);
      capFlip.hidden = false;
      shutter.disabled = true;
      shutter.className = st.mode === 'video' ? 'video' : '';
      shutter.setAttribute('aria-label', st.mode === 'video' ? 'Start recording' : 'Take photo');
      capTitle.textContent = st.mode === 'video' ? 'Video (up to 15s)' : 'Photo';
      hint.textContent = st.mode === 'video'
        ? 'Show the problem and talk us through it. Recording stops at 15 seconds.'
        : 'Your photo is only shared with this business.';
    }

    function showFallback(text) {
      stopStream(); clearTimers();
      show(live, false); show(shot, false); show(clip, false);
      show(liveRow, false); show(reviewRow, false);
      capFlip.hidden = true;
      capMsg.innerHTML = '';
      var p = document.createElement('div'); p.textContent = text; capMsg.appendChild(p);
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'capBtn main';
      b.textContent = st.mode === 'video' ? 'Use my camera app' : 'Use my camera app or photos';
      b.onclick = function () {
        var input = st.mode === 'video' ? fileVideo : filePhoto;
        input.value = ''; input.click();
      };
      capMsg.appendChild(b);
      show(capMsg, true);
    }

    function startStream() {
      stopStream();
      setLiveUI();
      var wantAudio = st.mode === 'video';
      var video = { facingMode: { ideal: st.facing }, width: { ideal: 1280 }, height: { ideal: 720 } };
      function attach(stream) {
        st.stream = stream;
        live.srcObject = stream;
        // Selfie view is mirrored so it feels natural; the saved image is not.
        live.style.transform = st.facing === 'user' ? 'scaleX(-1)' : '';
        var p = live.play && live.play();
        if (p && p.catch) p.catch(function () {});
        shutter.disabled = false;
      }
      return navigator.mediaDevices.getUserMedia({ video: video, audio: wantAudio })
        .catch(function (err) {
          if (wantAudio) return navigator.mediaDevices.getUserMedia({ video: video, audio: false });
          throw err;
        })
        .then(attach)
        .catch(function (err) {
          console.warn('Camera unavailable', err && err.name);
          showFallback("I can't open the camera here. That usually means camera access is blocked for this page.");
        });
    }

    function openCapture(mode) {
      st.mode = mode;
      st.blob = null; st.kind = null; st.poster = null; revokeUrl();
      note.value = '';
      cap.classList.add('on');
      startStream();
    }

    function closeCapture() {
      if (st.recorder && st.recorder.state !== 'inactive') {
        st.discard = true;
        try { st.recorder.stop(); } catch (e) {}
      }
      stopStream(); clearTimers(); revokeUrl();
      try { clip.pause(); } catch (e) {}
      clip.removeAttribute('src'); shot.removeAttribute('src');
      cap.classList.remove('on');
    }

    capClose.onclick = closeCapture;
    capFlip.onclick = function () {
      if (st.recorder && st.recorder.state === 'recording') return;
      st.facing = st.facing === 'environment' ? 'user' : 'environment';
      startStream();
    };

    /* ── capture ── */
    function canvasFrom(source, w, h, maxEdge) {
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
      return c;
    }
    function canvasToBlob(c, q) {
      return new Promise(function (resolve) {
        if (c.toBlob) c.toBlob(function (b) { resolve(b); }, 'image/jpeg', q);
        else {
          var d = c.toDataURL('image/jpeg', q), bin = atob(d.split(',')[1]), u = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          resolve(new Blob([u], { type: 'image/jpeg' }));
        }
      });
    }

    function snapPhoto() {
      var w = live.videoWidth, h = live.videoHeight;
      if (!w || !h) return;
      var c = canvasFrom(live, w, h, PHOTO_MAX_EDGE);
      canvasToBlob(c, 0.86).then(function (b) {
        if (!b) return;
        stopStream();
        review(b, 'photo', 0, c.toDataURL('image/jpeg', 0.6));
      });
    }

    function pickVideoMime() {
      var c = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
      for (var i = 0; i < c.length; i++) {
        try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {}
      }
      return '';
    }

    function startClip() {
      if (!st.stream) return;
      var mime = pickVideoMime();
      var rec;
      try {
        rec = mime ? new MediaRecorder(st.stream, { mimeType: mime, videoBitsPerSecond: 2000000 })
                   : new MediaRecorder(st.stream);
      } catch (e) {
        showFallback("This browser can't record video here.");
        return;
      }
      st.recorder = rec; st.chunks = []; st.discard = false;
      rec.ondataavailable = function (e) { if (e.data && e.data.size) st.chunks.push(e.data); };
      rec.onstop = function () {
        var dur = Date.now() - st.recStart;
        clearTimers();
        st.recorder = null;
        var type = (rec.mimeType || mime || 'video/webm').split(';')[0];
        var blob = new Blob(st.chunks, { type: type });
        st.chunks = [];
        if (st.discard) return;
        stopStream();
        if (!blob.size) { showFallback('Nothing was recorded. Please try again.'); return; }
        review(blob, 'video', dur, null);
      };
      rec.start(250);
      st.recStart = Date.now();
      shutter.className = 'video rec';
      shutter.setAttribute('aria-label', 'Stop recording');
      capFlip.hidden = true;
      timer.textContent = '0:00 / 0:15';
      timer.classList.add('on');
      st.tick = setInterval(function () { timer.textContent = fmt(Date.now() - st.recStart) + ' / 0:15'; }, 250);
      st.stopTimer = setTimeout(stopClip, CLIP_MAX_MS);
    }
    function stopClip() {
      if (st.recorder && st.recorder.state !== 'inactive') { try { st.recorder.stop(); } catch (e) {} }
    }

    shutter.onclick = function () {
      if (st.mode === 'photo') { snapPhoto(); return; }
      if (st.recorder && st.recorder.state === 'recording') stopClip();
      else startClip();
    };

    /* ── review ── */
    function review(blob, kind, durationMs, poster) {
      st.blob = blob; st.kind = kind; st.durationMs = durationMs || 0; st.poster = poster || null;
      revokeUrl();
      st.url = URL.createObjectURL(blob);
      cap.classList.add('on');
      show(live, false); show(capMsg, false); show(liveRow, false); show(reviewRow, true);
      capFlip.hidden = true;
      capTitle.textContent = kind === 'video' ? 'Your video' : 'Your photo';
      hint.textContent = 'Only shared with this business. Add a note if it helps.';
      if (kind === 'video') { show(shot, false); show(clip, true); clip.src = st.url; }
      else { show(clip, false); show(shot, true); shot.src = st.url; }
      setTimeout(function () { try { note.focus(); } catch (e) {} }, 50);
    }

    retake.onclick = function () {
      try { clip.pause(); } catch (e) {}
      if (!hasLiveCam || st.fromFile) { closeCapture(); st.fromFile = false; return; }
      startStream();
    };
    sendBtn.onclick = function () {
      if (!st.blob) return;
      var payload = { blob: st.blob, kind: st.kind, durationMs: st.durationMs, poster: st.poster, note: (note.value || '').trim() };
      st.blob = null;
      st.fromFile = false;
      closeCapture();
      sendMedia(payload);
    };
    note.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });

    /* ── picked files ── */
    function photoFileToJpeg(file) {
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var c = canvasFrom(img, img.naturalWidth, img.naturalHeight, PHOTO_MAX_EDGE);
          URL.revokeObjectURL(url);
          canvasToBlob(c, 0.86).then(function (b) { resolve({ blob: b || file, poster: c.toDataURL('image/jpeg', 0.6) }); });
        };
        // The browser can't decode it (e.g. HEIC outside Safari): send as-is
        // and let the server say whether it can read it.
        img.onerror = function () { URL.revokeObjectURL(url); resolve({ blob: file, poster: null }); };
        img.src = url;
      });
    }

    function videoDuration(blob, knownMs) {
      return new Promise(function (resolve) {
        if (knownMs) { resolve(knownMs); return; }
        var v = document.createElement('video');
        var url = URL.createObjectURL(blob);
        var done = function (ms) { URL.revokeObjectURL(url); resolve(ms); };
        v.preload = 'metadata'; v.muted = true;
        v.onloadedmetadata = function () { done(isFinite(v.duration) ? Math.round(v.duration * 1000) : 0); };
        v.onerror = function () { done(0); };
        setTimeout(function () { done(0); }, 5000);
        v.src = url;
      });
    }

    function onPicked(file) {
      if (!file) return;
      var type = String(file.type || '').toLowerCase();
      st.fromFile = true;
      if (type.indexOf('video/') === 0) {
        videoDuration(file, 0).then(function (ms) {
          if (ms && ms > CLIP_MAX_MS + 1500) {
            addBotMsg('That video is a bit long. Please send a clip of 15 seconds or less.');
            return;
          }
          st.mode = 'video';
          review(file, 'video', ms, null);
        });
        return;
      }
      st.mode = 'photo';
      photoFileToJpeg(file).then(function (r) { review(r.blob, 'photo', 0, r.poster); });
    }
    [filePhoto, fileVideo, fileAny].forEach(function (input) {
      input.addEventListener('change', function () { onPicked(input.files && input.files[0]); });
    });

    /* ── frames for the AI (video only) ── */
    function extractFrames(blob, count, knownMs) {
      return new Promise(function (resolve) {
        var frames = [];
        var v = document.createElement('video');
        var url = URL.createObjectURL(blob);
        var finished = false;
        function finish() {
          if (finished) return;
          finished = true;
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve(frames);
        }
        setTimeout(finish, 9000);
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.onerror = finish;
        function grabAt(times, i) {
          if (i >= times.length) { finish(); return; }
          v.onseeked = function () {
            try {
              var c = canvasFrom(v, v.videoWidth, v.videoHeight, FRAME_MAX_EDGE);
              frames.push(c.toDataURL('image/jpeg', 0.72));
            } catch (e) {}
            grabAt(times, i + 1);
          };
          try { v.currentTime = times[i]; } catch (e) { finish(); }
        }
        function begin(durSec) {
          if (!durSec || !isFinite(durSec)) durSec = (knownMs || 3000) / 1000;
          var times = [];
          for (var k = 0; k < count; k++) times.push(Math.max(0.05, durSec * (0.1 + (0.8 * k) / Math.max(1, count - 1))));
          grabAt(times, 0);
        }
        v.onloadeddata = function () {
          if (isFinite(v.duration) && v.duration > 0) { begin(v.duration); return; }
          // Chrome's MediaRecorder webm reports an infinite duration until it
          // has been seeked to the end once.
          v.ontimeupdate = function () {
            v.ontimeupdate = null;
            var d = v.duration;
            v.currentTime = 0;
            setTimeout(function () { begin(isFinite(d) ? d : 0); }, 50);
          };
          try { v.currentTime = 1e6; } catch (e) { begin(0); }
        };
        v.src = url;
      });
    }

    /* ── chat bubble ── */
    function addMediaBubble(kind, thumb, text, durationMs) {
      var wrap = addMsg('usr', text || (kind === 'video' ? 'Video' : 'Photo'), true);
      var inner = wrap.querySelector('.btext');
      if (thumb) {
        var box = document.createElement('div');
        box.className = 'bmedia';
        var img = document.createElement('img');
        img.alt = kind === 'video' ? 'Your video' : 'Your photo';
        img.src = thumb;
        box.appendChild(img);
        if (kind === 'video') {
          var badge = document.createElement('span');
          badge.className = 'bplay';
          badge.textContent = '▶ ' + fmt(durationMs || 0);
          box.appendChild(badge);
        }
        inner.insertBefore(box, inner.firstChild);
        if (!text) { var t = inner.lastChild; if (t && t.nodeType === 3) inner.removeChild(t); }
      }
      msgs.scrollTop = msgs.scrollHeight;
    }

    function postJson(url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; return d; }); });
    }

    function sendMedia(p) {
      if (sending) return;
      sending = true;
      if (cam) cam.disabled = true;
      var label = p.kind === 'video' ? '[Sent a video clip]' : '[Sent a photo]';
      history.push({ role: 'user', text: label + (p.note ? ' ' + p.note : '') });
      saveSession();

      var framesP = p.kind === 'video' ? extractFrames(p.blob, 4, p.durationMs) : Promise.resolve([]);
      framesP.then(function (frames) {
        var thumb = p.poster || frames[0] || null;
        addMediaBubble(p.kind, thumb, p.note, p.durationMs);
        showTyping();
        var sid = mediaSessionId();
        var qs = '?chatbotId=' + encodeURIComponent(CID) + '&sessionId=' + encodeURIComponent(sid) +
                 (p.durationMs ? '&durationMs=' + Math.round(p.durationMs) : '');
        var headers = { 'Content-Type': p.blob.type || (p.kind === 'video' ? 'video/webm' : 'image/jpeg') };
        var tok = mediaToken();
        if (tok) headers['X-Agently-Media-Token'] = tok;
        return fetch(API + '/api/chatbot-public/media' + qs, { method: 'POST', headers: headers, body: p.blob })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; return d; }); })
          .then(function (up) {
            if (!up.mediaId) {
              var m = (up.error && up.error.message) || up.response || "That didn't upload. Please try again.";
              throw { visible: m };
            }
            return postJson(API + '/api/chatbot-public/media/' + encodeURIComponent(up.mediaId) + '/analyze', {
              chatbotId: CID, sessionId: sid, mediaToken: tok || undefined,
              frames: frames, note: p.note, history: history.slice(-8), language: currentLang
            });
          })
          .then(function (d) {
            hideTyping();
            var reply = d.response || (d.error && d.error.message) || 'Thanks for sending that! How can I help with it?';
            addBotMsg(reply); speakReply(reply);
          });
      })
      .catch(function (err) {
        hideTyping();
        addBotMsg((err && err.visible) || "Sorry, I couldn't receive that just now. Please try again in a moment.");
      })
      .then(function () {
        sending = false;
        if (cam) cam.disabled = false;
        maybeTriggerLeadCapture();
      });
    }
  })();
`;

module.exports = { CSS, BUTTON, MARKUP, SCRIPT };
