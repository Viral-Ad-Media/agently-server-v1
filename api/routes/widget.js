"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");

const router = express.Router();

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = getSupabase();

    const { data: chatbot, error } = await db
      .from("chatbots")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !chatbot) {
      return res.status(404)
        .send(`<!DOCTYPE html><html><head><title>Not Found</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;color:#94a3b8"><p style="font-size:48px;margin:0">🤖</p><p>Widget not found.</p></div>
</body></html>`);
    }

    const apiUrl = (process.env.API_URL || "").replace(/\/$/, "");
    const queryLangs = req.query.langs
      ? String(req.query.langs).split(",").filter(Boolean)
      : null;
    const queryVoice = req.query.voice ? String(req.query.voice) : null;

    const chatLanguages =
      queryLangs ||
      (Array.isArray(chatbot.chat_languages) ? chatbot.chat_languages : ["en"]);
    const chatVoice = queryVoice || chatbot.chat_voice || "alloy";

    const cfg = {
      chatbotId: safeStr(id),
      apiUrl: safeStr(apiUrl),
      accentColor: safeStr(chatbot.accent_color || "#4f46e5"),
      headerTitle: safeStr(chatbot.header_title || "Chat with us"),
      welcomeMessage: safeStr(
        chatbot.welcome_message || "Hello! How can I help you today?",
      ),
      placeholder: safeStr(chatbot.placeholder || "Type your message..."),
      avatarLabel: safeStr(chatbot.avatar_label || "A"),
      position: chatbot.position === "left" ? "left" : "right",
      suggestedPrompts: JSON.stringify(
        Array.isArray(chatbot.suggested_prompts)
          ? chatbot.suggested_prompts
          : [],
      ),
      faqs: JSON.stringify(Array.isArray(chatbot.faqs) ? chatbot.faqs : []),
      chatLanguages: JSON.stringify(chatLanguages),
      chatVoice: safeStr(chatVoice),
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https:;",
    );
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(buildWidgetHtml(cfg));
  } catch (e) {
    console.error("[widget] handler error:", e);
    // Return a visible fallback instead of crashing the whole function
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html><head><title>Error</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;">
<div style="text-align:center;color:#94a3b8"><p style="font-size:48px;margin:0">⚠️</p><p>Widget temporarily unavailable.</p></div>
</body></html>`);
  }
});

function safeStr(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, "\\n")
    .replace(/<\/script>/gi, "<\\/script>");
}

const LANG_NAMES = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  ar: "العربية",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  nl: "Nederlands",
};

function buildWidgetHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${cfg.headerTitle.replace(/\\'/g, "'").replace(/\\n/g, "")}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:transparent !important;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
body{margin:0!important;padding:0!important;display:block!important;visibility:visible!important}
body>*:not(#agently-root):not(script){display:none!important}
:root{--a:${cfg.accentColor};--ad:${cfg.accentColor}cc;--al:${cfg.accentColor}18}
#agently-root{position:absolute!important;bottom:20px!important;${cfg.position}:20px!important;left:auto;right:auto;width:420px;height:800px;max-width:90vw;max-height:90vh;overflow:visible;display:block!important;visibility:visible!important;z-index:2147483647}
#launcher{position:absolute;bottom:0;${cfg.position}:20px;width:56px;height:56px;background:var(--a);border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.22);color:#fff;z-index:2147483646;transition:transform .2s,box-shadow .2s;}
#launcher:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,.28)}
#launcher svg{pointer-events:none}
#cw{position:absolute;bottom:68px;${cfg.position}:16px;width:370px;max-width:calc(100vw - 32px);height:580px;max-height:calc(100vh - 104px);background:#fff;border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;transform-origin:bottom ${cfg.position};transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;}
#cw.hide{transform:scale(.85) translateY(12px);opacity:0;pointer-events:none}
.hdr{background:var(--a);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px;flex-shrink:0;}
.av{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0;letter-spacing:-.02em;}
.ht{flex:1;min-width:0}.hn{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hs{font-size:11px;opacity:.82;margin-top:1px;display:flex;align-items:center;gap:5px}
.dot{width:7px;height:7px;background:#4ade80;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.xb{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.8;transition:opacity .2s,background .2s;margin-left:4px}
.xb:hover{opacity:1;background:rgba(255,255,255,.15)}
/* Language bar */
#lang-bar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #eef2f7;background:#f8fafc;flex-shrink:0;overflow-x:auto;align-items:center;}
#lang-bar:empty{display:none}
#lang-bar::-webkit-scrollbar{display:none}
.lang-btn{white-space:nowrap;background:#fff;border:1.5px solid #e2e8f0;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;color:#374151;transition:border-color .15s,color .15s,background .15s;flex-shrink:0;}
.lang-btn.active{border-color:var(--a);color:var(--a);background:var(--al)}
.lang-lbl{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-right:2px;flex-shrink:0}
#msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;scroll-behavior:smooth;}
#msgs::-webkit-scrollbar{width:4px}
#msgs::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}
.bubble{max-width:84%;display:flex;flex-direction:column}
.bubble.bot{align-self:flex-start}
.bubble.usr{align-self:flex-end;align-items:flex-end}
.btext{padding:10px 14px;border-radius:18px;font-size:13.5px;line-height:1.6;word-break:break-word;}
.bot .btext{background:#fff;border:1px solid #e8edf2;border-bottom-left-radius:4px;color:#1e293b;}
.usr .btext{background:var(--a);color:#fff;border-bottom-right-radius:4px;}
.btext p{margin:0 0 8px}.btext p:last-child{margin-bottom:0}
.btext ul,.btext ol{margin:6px 0 6px 18px;padding:0}
.btext li{margin-bottom:3px}
.btext a{color:inherit;text-decoration:underline}
.btime{font-size:10px;color:#94a3b8;margin-top:3px;padding:0 4px}
.typing .btext{padding:12px 16px}
.tdots{display:flex;gap:4px;align-items:center}
.td{width:7px;height:7px;background:#94a3b8;border-radius:50%;animation:bop 1.3s infinite}
.td:nth-child(2){animation-delay:.2s}.td:nth-child(3){animation-delay:.4s}
@keyframes bop{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
#chips{display:flex;gap:7px;padding:8px 14px;overflow-x:auto;flex-shrink:0;background:#f8fafc;border-top:1px solid #eef2f7;}
#chips:empty{display:none}
#chips::-webkit-scrollbar{display:none}
.chip{white-space:nowrap;background:#fff;border:1.5px solid #e2e8f0;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;color:#374151;transition:border-color .15s,color .15s,background .15s;flex-shrink:0;}
.chip:hover{border-color:var(--a);color:var(--a);background:var(--al)}
.ir{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eef2f7;background:#fff;flex-shrink:0;align-items:flex-end;}
#ci{flex:1;padding:10px 13px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:13.5px;outline:none;resize:none;min-height:42px;max-height:100px;transition:border-color .2s;font-family:inherit;line-height:1.4;overflow-y:auto;}
#ci:focus{border-color:var(--a)}
#ci:disabled{background:#f8fafc;color:#94a3b8;cursor:not-allowed}
#sb{background:var(--a);color:#fff;border:none;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:opacity .2s,transform .15s;}
#sb:hover{opacity:.88;transform:scale(1.04)}
#sb:active{transform:scale(.96)}
#sb:disabled{opacity:.45;cursor:not-allowed;transform:none}
/* Mic button (left of send) */
#mic{background:#fff;border:1.5px solid #e2e8f0;color:#64748b;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all .2s;}
#mic:hover{border-color:var(--a);color:var(--a);background:var(--al)}
#mic:disabled{opacity:.45;cursor:not-allowed}
#mic.recording{background:#ef4444;color:#fff;border-color:#ef4444;animation:recPulse 1.1s ease-in-out infinite;}
@keyframes recPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}
/* Recording indicator overlay — shown in place of input during capture */
#recBar{flex:1;display:none;align-items:center;gap:10px;padding:10px 13px;border:1.5px solid #ef4444;border-radius:12px;background:#fef2f2;color:#b91c1c;font-size:13px;font-weight:600;min-height:42px;}
#recBar.on{display:flex}
#recBar .dotRed{width:9px;height:9px;background:#ef4444;border-radius:50%;animation:pulse 1.2s infinite;flex-shrink:0}
#recBar .recWave{display:flex;align-items:center;gap:2px;flex:1;height:18px;overflow:hidden}
#recBar .recWave span{display:block;width:3px;background:#ef4444;border-radius:2px;animation:wave 1s ease-in-out infinite;}
#recBar .recWave span:nth-child(1){animation-delay:-.9s}
#recBar .recWave span:nth-child(2){animation-delay:-.75s}
#recBar .recWave span:nth-child(3){animation-delay:-.6s}
#recBar .recWave span:nth-child(4){animation-delay:-.45s}
#recBar .recWave span:nth-child(5){animation-delay:-.3s}
#recBar .recWave span:nth-child(6){animation-delay:-.15s}
#recBar .recWave span:nth-child(7){animation-delay:0s}
@keyframes wave{0%,100%{height:5px}50%{height:18px}}
#recBar .recTime{font-variant-numeric:tabular-nums;color:#7f1d1d;font-size:12px;flex-shrink:0}
/* Speaker toggle in header */
#spk{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.6;transition:opacity .2s,background .2s;}
#spk:hover{opacity:1;background:rgba(255,255,255,.15)}
#spk.on{opacity:1;background:rgba(255,255,255,.2)}
#spk.playing{animation:spkPulse 1.4s ease-in-out infinite}
@keyframes spkPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
.pw{text-align:center;font-size:10.5px;color:#94a3b8;padding:5px 14px 7px;background:#fff;border-top:1px solid #f1f5f9;flex-shrink:0;letter-spacing:.01em;}
.pw a{color:var(--a);text-decoration:none;font-weight:600}
.pw a:hover{text-decoration:underline}
</style>
</head>
<body>
<div id="agently-root">
<div id="cw" class="hide" role="dialog" aria-label="Chat window">
  <div class="hdr">
    <div class="av" aria-hidden="true">${cfg.avatarLabel.replace(/\\'/g, "'")}</div>
    <div class="ht">
      <div class="hn">${cfg.headerTitle.replace(/\\'/g, "'").replace(/\\n/g, "")}</div>
      <div class="hs"><span class="dot"></span>Online · Instant replies</div>
    </div>
    <button class="xb" id="spk" aria-label="Toggle voice replies" title="Voice replies off"><svg id="ico-spk-off" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg><svg id="ico-spk-on" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>
    <button class="xb" id="xb" aria-label="Close chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
  </div>
  <div id="lang-bar" role="list" aria-label="Language selector"></div>
  <div id="msgs" role="log" aria-live="polite" aria-label="Chat messages"></div>
  <div id="chips" role="list" aria-label="Suggested questions"></div>
  <div class="ir">
    <button id="mic" aria-label="Record voice message" title="Record voice"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg></button>
    <textarea id="ci" placeholder="${cfg.placeholder.replace(/\\'/g, "'")}" rows="1" aria-label="Message input"></textarea>
    <div id="recBar" aria-live="polite"><span class="dotRed"></span><span class="recWave"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span><span class="recTime" id="recTime">0:00</span></div>
    <button id="sb" aria-label="Send message" disabled><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
  </div>
  <div class="pw">Powered by <a href="https://agently.ai" target="_blank" rel="noopener">Agently</a></div>
</div>
<button id="launcher" aria-label="Open chat" aria-expanded="false">
  <svg id="ico-chat" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <svg id="ico-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:none"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
</button>
</div>
<script>
(function() {
  'use strict';
  console.log('Agently widget script loaded');
  window.addEventListener('error', function(e){ console.error('Agently widget runtime error', e && e.message ? e.message : e); });

  var CID = '${cfg.chatbotId}';
  var API = '${cfg.apiUrl}';
  var WELCOME = '${cfg.welcomeMessage}';
  var FAQS = ${cfg.faqs};
  var PROMPTS = ${cfg.suggestedPrompts};
  var LANGUAGES = ${cfg.chatLanguages};
  var LANG_NAMES = ${JSON.stringify(LANG_NAMES)};

  var currentLang = LANGUAGES[0] || 'en';
  var isOpen = false;
  var greeted = false;
  var sending = false;
  var history = [];

  var cw = document.getElementById('cw');
  var launcher = document.getElementById('launcher');
  var xb = document.getElementById('xb');
  var msgs = document.getElementById('msgs');
  var chips = document.getElementById('chips');
  var ci = document.getElementById('ci');
  var sb = document.getElementById('sb');
  var icoChat = document.getElementById('ico-chat');
  var icoClose = document.getElementById('ico-close');
  var langBar = document.getElementById('lang-bar');
  var mic = document.getElementById('mic');
  var spk = document.getElementById('spk');
  var icoSpkOff = document.getElementById('ico-spk-off');
  var icoSpkOn = document.getElementById('ico-spk-on');
  var recBar = document.getElementById('recBar');
  var recTime = document.getElementById('recTime');

  if (!cw || !launcher) { console.error('Critical elements missing'); return; }

  /* ── Language bar ── */
  if (LANGUAGES.length > 1) {
    var lbl = document.createElement('span');
    lbl.className = 'lang-lbl';
    lbl.textContent = 'Lang:';
    langBar.appendChild(lbl);

    LANGUAGES.forEach(function(code) {
      var btn = document.createElement('button');
      btn.className = 'lang-btn' + (code === currentLang ? ' active' : '');
      btn.textContent = LANG_NAMES[code] || code.toUpperCase();
      btn.dataset.lang = code;
      btn.onclick = function() {
        currentLang = code;
        langBar.querySelectorAll('.lang-btn').forEach(function(b) {
          b.classList.toggle('active', b.dataset.lang === code);
        });
      };
      langBar.appendChild(btn);
    });
  }

  /* ── Suggested prompts ── */
  PROMPTS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = p;
    btn.onclick = function() { sendMessage(p); };
    chips.appendChild(btn);
  });

  var sessionLoaded = false;

  function toggle() {
    isOpen = !isOpen;
    cw.classList.toggle('hide', !isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    icoChat.style.display = isOpen ? 'none' : '';
    icoClose.style.display = isOpen ? '' : 'none';
    if (isOpen && !sessionLoaded) { sessionLoaded = true; loadSession(); }
    if (isOpen && !greeted) { greeted = true; setTimeout(function() { addBotMsg(WELCOME); }, 200); }
    if (isOpen) { setTimeout(function() { ci.focus(); }, 250); }
    // Closing the widget: stop any active recording and any TTS playback
    if (!isOpen) {
      if (recording) { try { stopRecording(); } catch(_) {} }
      stopPlayback();
    }
  }

  launcher.onclick = toggle;
  xb.onclick = toggle;

  ci.oninput = function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    sb.disabled = !this.value.trim();
  };
  ci.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sb.disabled) sendMessage(); }
  };
  sb.onclick = function() { sendMessage(); };

  /* ══════════════════════════════════════════════════════════
   * VOICE FEATURES: speaker toggle + mic recording + TTS playback
   * ══════════════════════════════════════════════════════════ */
  var speakMode = false;          // true when user has toggled voice replies ON
  var recording = false;
  var mediaRecorder = null;
  var audioChunks = [];
  var mediaStream = null;
  var recStart = 0;
  var recTimer = null;
  var currentAudio = null;        // currently-playing TTS Audio element
  var hasMediaRecorder = typeof window.MediaRecorder !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  if (!hasMediaRecorder && mic) {
    // Browser doesn't support recording — hide mic button
    mic.style.display = 'none';
  }

  /* Speaker toggle — turns auto-play of TTS on bot replies on/off */
  if (spk) {
    spk.onclick = function() {
      speakMode = !speakMode;
      spk.classList.toggle('on', speakMode);
      spk.title = speakMode ? 'Voice replies on' : 'Voice replies off';
      if (icoSpkOff && icoSpkOn) {
        icoSpkOff.style.display = speakMode ? 'none' : '';
        icoSpkOn.style.display = speakMode ? '' : 'none';
      }
      // If turning off, stop any currently-playing audio
      if (!speakMode) stopPlayback();
    };
  }

  function stopPlayback() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch(_) {}
      currentAudio = null;
    }
    if (spk) spk.classList.remove('playing');
  }

  /* Pick the audio format the browser supports for MediaRecorder */
  function pickMimeType() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i];
      }
    }
    return '';
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function setRecordingUI(on) {
    recording = on;
    mic.classList.toggle('recording', on);
    mic.title = on ? 'Stop recording' : 'Record voice';
    ci.style.display = on ? 'none' : '';
    recBar.classList.toggle('on', on);
    if (on) {
      recStart = Date.now();
      recTime.textContent = '0:00';
      recTimer = setInterval(function() {
        recTime.textContent = fmtDuration(Date.now() - recStart);
      }, 250);
    } else {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
    }
  }

  /* Mic button — toggle recording */
  if (mic) {
    mic.onclick = function() {
      if (recording) { stopRecording(); return; }
      startRecording();
    };
  }

  function startRecording() {
    if (!hasMediaRecorder) return;
    stopPlayback(); // pause any TTS while we record
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        mediaStream = stream;
        audioChunks = [];
        var mimeType = pickMimeType();
        try {
          mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
        } catch (err) {
          console.error('MediaRecorder init failed', err);
          cleanupStream();
          return;
        }
        mediaRecorder.ondataavailable = function(e) {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = function() {
          setRecordingUI(false);
          var blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
          cleanupStream();
          if (blob.size < 500) {
            // Too short — skip
            return;
          }
          void transcribeAndFill(blob);
        };
        mediaRecorder.start();
        setRecordingUI(true);
      })
      .catch(function(err) {
        console.error('Mic permission denied', err);
        addBotMsg(currentLang === 'es'
          ? 'Necesito acceso al micrófono para grabar. Por favor, permite el acceso e inténtalo de nuevo.'
          : 'I need microphone access to record. Please allow access and try again.');
      });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch(_) {}
    } else {
      setRecordingUI(false);
      cleanupStream();
    }
  }

  function cleanupStream() {
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(function(t) { t.stop(); }); } catch(_) {}
      mediaStream = null;
    }
  }

  /* Send audio blob to /transcribe, fill textarea with result */
  function transcribeAndFill(blob) {
    ci.disabled = true;
    sb.disabled = true;
    mic.disabled = true;
    var placeholder = currentLang === 'es' ? 'Transcribiendo…' : 'Transcribing…';
    ci.value = '';
    ci.placeholder = placeholder;

    return fetch(API + '/api/chatbot-public/transcribe?chatbotId=' + encodeURIComponent(CID), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    })
    .then(function(r) {
      return r.ok ? r.json() : r.json().then(function(e) { throw new Error((e && e.error && e.error.message) || 'Transcription failed'); });
    })
    .then(function(data) {
      ci.value = (data && data.text) || '';
      if (ci.value.trim()) {
        // Auto-resize and auto-send the transcribed message
        ci.style.height = 'auto';
        ci.style.height = Math.min(ci.scrollHeight, 100) + 'px';
        sendMessage();
      }
    })
    .catch(function(err) {
      console.error('Transcribe error', err);
      addBotMsg(currentLang === 'es'
        ? 'No pude transcribir ese audio. Por favor, inténtalo de nuevo.'
        : "I couldn't transcribe that audio. Please try again.");
    })
    .finally(function() {
      ci.disabled = false;
      mic.disabled = false;
      ci.placeholder = '${cfg.placeholder.replace(/\\'/g, "'")}';
      sb.disabled = !ci.value.trim();
    });
  }

  /* Call /speak and play the returned mp3 */
  function speakReply(text) {
    if (!speakMode || !text) return;
    stopPlayback();
    fetch(API + '/api/chatbot-public/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, chatbotId: CID }),
    })
    .then(function(r) { return r.ok ? r.blob() : null; })
    .then(function(blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      if (spk) spk.classList.add('playing');
      currentAudio.onended = function() {
        if (spk) spk.classList.remove('playing');
        URL.revokeObjectURL(url);
        currentAudio = null;
      };
      currentAudio.onerror = function() {
        if (spk) spk.classList.remove('playing');
        currentAudio = null;
      };
      currentAudio.play().catch(function(err) {
        // Autoplay policies may block — user needs to interact once first
        console.warn('Audio play blocked:', err);
        if (spk) spk.classList.remove('playing');
      });
    })
    .catch(function(err) { console.warn('TTS failed:', err); });
  }
  /* ══════════════════════════════════════════════════════════ */

  function ft() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* FIX: renderMd properly handles \\n escape sequences and formats output as HTML */
  function renderMd(text) {
    var s = String(text || '');
    // Decode escaped newlines first
    s = s.replace(/\\\\n/g, '\\n').replace(/\\n/g, '\\n');
    // Escape HTML
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    // Bold and italic
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*([^\\*\\n]+?)\\*/g, '<em>$1</em>');
    s = s.replace(/_([^_\\n]+?)_/g, '<em>$1</em>');
    // Links
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|\\s)(https?:\\/\\/[^\\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    // Lists
    var lines = s.split('\\n');
    var out = [];
    var inUl = false, inOl = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var ulMatch = line.match(/^[*\\-•] (.+)/);
      var olMatch = line.match(/^\\d+\\. (.+)/);
      if (ulMatch) {
        if (!inUl) { out.push('<ul>'); inUl = true; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        out.push('<li>' + ulMatch[1] + '</li>');
      } else if (olMatch) {
        if (!inOl) { out.push('<ol>'); inOl = true; }
        if (inUl) { out.push('</ul>'); inUl = false; }
        out.push('<li>' + olMatch[1] + '</li>');
      } else {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (line.trim() === '') {
          out.push('<br>');
        } else {
          out.push('<p>' + line + '</p>');
        }
      }
    }
    if (inUl) out.push('</ul>');
    if (inOl) out.push('</ol>');
    return out.join('');
  }

  var SESS_KEY = 'agently_chat_' + CID;

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return;
      saved.forEach(function(m) {
        if (m.role && m.text) {
          if (m.role === 'model') { history.push({ role: 'model', text: m.text }); addMsg('bot', m.text, true); }
          else { history.push({ role: 'user', text: m.text }); addMsg('usr', m.text, true); }
        }
      });
      greeted = true;
    } catch(e) {}
  }

  function saveSession() {
    try { sessionStorage.setItem(SESS_KEY, JSON.stringify(history.slice(-40))); } catch(e) {}
  }

  function addMsg(role, text, skipSave) {
    var wrap = document.createElement('div');
    wrap.className = 'bubble ' + (role === 'bot' ? 'bot' : 'usr');
    var inner = document.createElement('div');
    inner.className = 'btext';
    inner.innerHTML = role === 'bot' ? renderMd(text) : text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var time = document.createElement('div');
    time.className = 'btime';
    time.textContent = ft();
    wrap.appendChild(inner);
    wrap.appendChild(time);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    if (!skipSave) saveSession();
    return wrap;
  }

  function addBotMsg(text) { history.push({ role: 'model', text: text }); return addMsg('bot', text); }
  function addUserMsg(text) { history.push({ role: 'user', text: text }); return addMsg('usr', text); }

  function showTyping() {
    var wrap = document.createElement('div');
    wrap.id = 'typ'; wrap.className = 'bubble bot typing';
    var inner = document.createElement('div');
    inner.className = 'btext';
    inner.innerHTML = '<div class="tdots"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
    wrap.appendChild(inner);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping() { var t = document.getElementById('typ'); if (t) t.remove(); }

  function localAnswer(q) {
    var lq = q.toLowerCase();
    for (var i = 0; i < FAQS.length; i++) {
      var faq = FAQS[i];
      if (!faq.question) continue;
      var kw = faq.question.toLowerCase().split(/\\s+/).filter(function(w){ return w.length > 4; });
      var hits = kw.filter(function(k){ return lq.includes(k); });
      if (kw.length > 0 && hits.length >= Math.min(2, kw.length)) return faq.answer;
    }
    return null;
  }

  function sendMessage(preset) {
    if (sending) return;
    var text = (preset || ci.value).trim();
    if (!text) return;
    ci.value = '';
    ci.style.height = '';
    sb.disabled = true;
    sending = true;
    addUserMsg(text);
    showTyping();

    var local = localAnswer(text);
    if (local) {
      setTimeout(function() { hideTyping(); addBotMsg(local); speakReply(local); sending = false; ci.focus(); }, 500);
      return;
    }

    fetch(API + '/api/chatbot-public/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, chatbotId: CID, history: history.slice(-12), language: currentLang })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      hideTyping();
      var reply = (d.response || (d.error && d.error.message) || "I'm here to help! Could you rephrase that?");
      addBotMsg(reply);
      speakReply(reply);
    })
    .catch(function() {
      hideTyping();
      var msg = "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
      addBotMsg(msg);
    })
    .finally(function() { sending = false; ci.focus(); });
  }
})();
</script>
</body>
</html>`;
}

module.exports = router;
