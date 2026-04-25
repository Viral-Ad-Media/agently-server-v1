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

    // Look up the linked voice agent's name — used as the default lead tag
    let agentName = chatbot.name || chatbot.header_title || "Assistant";
    if (chatbot.voice_agent_id) {
      const { data: agent } = await db
        .from("voice_agents")
        .select("name")
        .eq("id", chatbot.voice_agent_id)
        .single();
      if (agent && agent.name) agentName = agent.name;
    }

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
      // Railway WebSocket URL for sub-second Realtime voice mode
      // Strip the /ws path from TWILIO_WS_URL to get the base WS server URL
      realtimeWsUrl: safeStr(
        (process.env.TWILIO_WS_URL || "")
          .trim()
          .replace(/\/ws$/, "")
          .replace(/\/$/, ""),
      ),
      // Lead capture feature — ON by default (only OFF if explicitly set to false)
      collectLeads: chatbot.collect_leads !== false,
      agentName: safeStr(agentName),
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      // data: allows base64 audio (TTS). blob: kept for legacy. media-src explicitly set.
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self' https: wss:;",
    );
    // Permissions-Policy: explicitly grant microphone to this iframe
    // Without this, even allow="microphone" on the parent iframe is blocked
    // by some browsers when the parent is a different origin.
    res.setHeader("Permissions-Policy", "microphone=*, camera=*, autoplay=*");
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
#mic.recording{background:var(--a);color:#fff;border-color:var(--a);animation:recPulse 1.1s ease-in-out infinite;}
@keyframes recPulse{0%,100%{box-shadow:0 0 0 0 rgba(79,70,229,.55)}50%{box-shadow:0 0 0 8px rgba(79,70,229,0)}}
/* Recording indicator overlay — shown in place of input during capture */
#recBar{flex:1;display:none;align-items:center;gap:10px;padding:10px 13px;border:1.5px solid var(--a);border-radius:12px;background:var(--al);color:var(--a);font-size:13px;font-weight:600;min-height:42px;}
#recBar.on{display:flex}
#recBar .dotRed{width:9px;height:9px;background:var(--a);border-radius:50%;animation:pulse 1.2s infinite;flex-shrink:0}
#recBar .recWave{display:flex;align-items:center;gap:2px;flex:1;height:18px;overflow:hidden}
#recBar .recWave span{display:block;width:3px;background:var(--a);border-radius:2px;animation:wave 1s ease-in-out infinite;}
#recBar .recWave span:nth-child(1){animation-delay:-.9s}
#recBar .recWave span:nth-child(2){animation-delay:-.75s}
#recBar .recWave span:nth-child(3){animation-delay:-.6s}
#recBar .recWave span:nth-child(4){animation-delay:-.45s}
#recBar .recWave span:nth-child(5){animation-delay:-.3s}
#recBar .recWave span:nth-child(6){animation-delay:-.15s}
#recBar .recWave span:nth-child(7){animation-delay:0s}
@keyframes wave{0%,100%{height:5px}50%{height:18px}}
#recBar .recTime{font-variant-numeric:tabular-nums;color:var(--a);opacity:.8;font-size:12px;flex-shrink:0}
/* Speaker toggle in header */
#spk{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.6;transition:opacity .2s,background .2s;}
#spk:hover{opacity:1;background:rgba(255,255,255,.15)}
#spk.on{opacity:1;background:rgba(255,255,255,.2)}
#spk.playing{animation:spkPulse 1.4s ease-in-out infinite}
@keyframes spkPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
/* ═══ LEAD CAPTURE FORM (inline in chat) ═══ */
.leadForm{background:#fff;border:1.5px solid var(--a);border-radius:16px;padding:14px 14px 12px;margin:2px 12px 10px;box-shadow:0 4px 14px rgba(0,0,0,.04);animation:fadeIn .3s ease-out}
.leadForm.submitted{opacity:.6;pointer-events:none}
.leadForm .lfTitle{font-size:12px;font-weight:800;color:var(--a);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.leadForm .lfIcon{width:14px;height:14px;flex-shrink:0}
.leadForm .lfHint{font-size:11.5px;color:#64748b;margin-bottom:10px;line-height:1.4}
.leadForm .lfField{margin-bottom:8px}
.leadForm .lfLabel{display:block;font-size:10.5px;font-weight:700;color:#475569;letter-spacing:.03em;margin-bottom:4px;text-transform:uppercase}
.leadForm .lfInput{width:100%;padding:9px 11px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;transition:border-color .2s;background:#f8fafc}
.leadForm .lfInput:focus{border-color:var(--a);background:#fff}
.leadForm .lfInput.invalid{border-color:#ef4444;background:#fef2f2}
.leadForm .lfRow{display:flex;gap:8px;margin-bottom:8px}
.leadForm .lfRow .lfField{flex:1;margin-bottom:0}
.leadForm .lfError{font-size:11px;color:#ef4444;margin-top:4px;display:none}
.leadForm .lfError.show{display:block}
.leadForm .lfActions{display:flex;gap:8px;margin-top:6px}
.leadForm .lfSubmit{flex:1;background:var(--a);color:#fff;border:none;padding:10px 14px;border-radius:10px;font-size:12.5px;font-weight:700;cursor:pointer;transition:opacity .2s}
.leadForm .lfSubmit:hover{opacity:.9}
.leadForm .lfSubmit:disabled{opacity:.5;cursor:not-allowed}
.leadForm .lfSkip{background:transparent;color:#94a3b8;border:none;padding:10px 12px;font-size:12px;font-weight:600;cursor:pointer}
.leadForm .lfSkip:hover{color:#475569}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
/* ═══ VOICE MODE OVERLAY ═══ */
#vMode{position:absolute;inset:0;background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);display:none;flex-direction:column;align-items:center;justify-content:space-between;padding:32px 24px;z-index:10;color:#fff;}
#vMode.on{display:flex}
.vmTop{display:flex;align-items:center;justify-content:space-between;width:100%;}
.vmLabel{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.5)}
.vmLang{font-size:11px;color:rgba(255,255,255,.6);padding:4px 10px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.04)}
.vmCenter{display:flex;flex-direction:column;align-items:center;gap:20px;flex:1;justify-content:center}
.vmOrb{width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 30% 30%,var(--a) 0%,var(--ad) 60%,rgba(0,0,0,.3) 100%);box-shadow:0 0 60px var(--a),inset 0 0 40px rgba(255,255,255,.1);transition:transform .1s ease-out;position:relative;}
.vmOrb::before{content:'';position:absolute;inset:-10px;border-radius:50%;border:2px solid var(--a);opacity:.35;animation:orbRing 2.4s ease-in-out infinite}
.vmOrb::after{content:'';position:absolute;inset:-22px;border-radius:50%;border:1.5px solid var(--a);opacity:.18;animation:orbRing 2.4s ease-in-out infinite;animation-delay:-.8s}
@keyframes orbRing{0%,100%{transform:scale(1);opacity:.1}50%{transform:scale(1.18);opacity:.45}}
.vmOrb.listening{animation:orbBreath 1.8s ease-in-out infinite}
.vmOrb.speaking{animation:orbSpeak .9s ease-in-out infinite}
.vmOrb.thinking{animation:orbSpin 1.4s linear infinite}
@keyframes orbBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes orbSpeak{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes orbSpin{0%{transform:rotate(0) scale(.96)}50%{transform:rotate(180deg) scale(1.02)}100%{transform:rotate(360deg) scale(.96)}}
.vmStatus{font-size:16px;font-weight:600;color:rgba(255,255,255,.95);text-align:center;min-height:22px;letter-spacing:.01em;}
.vmHint{font-size:12px;color:rgba(255,255,255,.45);text-align:center;max-width:260px;line-height:1.5}
.vmActions{display:flex;gap:10px;width:100%;justify-content:center;}
.vmBtn{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.15);padding:10px 18px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s}
.vmBtn:hover{background:rgba(255,255,255,.14)}
.vmBtn.vmEnd{background:#dc2626;border-color:#dc2626}
.vmBtn.vmEnd:hover{background:#b91c1c}
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
    <button class="xb" id="vmBtn" aria-label="Start voice conversation" title="Start voice conversation"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button>
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

  <!-- ═══ VOICE MODE OVERLAY (sits inside chat window) ═══ -->
  <div id="vMode" role="dialog" aria-label="Voice conversation">
    <div class="vmTop">
      <span class="vmLabel">Voice Mode</span>
      <span class="vmLang" id="vmLang">EN</span>
    </div>
    <div class="vmCenter">
      <div class="vmOrb" id="vmOrb"></div>
      <div class="vmStatus" id="vmStatus">Tap to start speaking…</div>
      <div class="vmHint" id="vmHint">Speak naturally. I'll wait for you to pause, then reply out loud.</div>
    </div>
    <div class="vmActions">
      <button class="vmBtn vmEnd" id="vmEnd" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>End conversation</button>
    </div>
  </div>
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
  var PLACEHOLDER = '${cfg.placeholder}';
  var COLLECT_LEADS = ${cfg.collectLeads};
  var AGENT_NAME = '${cfg.agentName}';
  // Railway WebSocket server URL for Realtime voice mode
  // e.g. wss://agently-ws-server-production.up.railway.app
  var REALTIME_WS_BASE = '${cfg.realtimeWsUrl}';
  // Browser-side conversation persistence with idle TTL.
  // Conversations are NEVER stored server-side — they live in sessionStorage
  // and auto-expire after 10 minutes of inactivity.
  var STORAGE_KEY = 'agently:' + CID;
  var IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes — chat history clears after 5 min of inactivity
  var LEAD_CAPTURED_KEY = 'agently:' + CID + ':leadCaptured';
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
  var vmBtn = document.getElementById('vmBtn');
  var vMode = document.getElementById('vMode');
  var vmOrb = document.getElementById('vmOrb');
  var vmStatus = document.getElementById('vmStatus');
  var vmHint = document.getElementById('vmHint');
  var vmLangEl = document.getElementById('vmLang');
  var vmEnd = document.getElementById('vmEnd');

  if (!cw || !launcher) { console.error('Critical elements missing'); return; }

  /* ── Language bar ── */
  function setActiveLang(code) {
    if (!code || LANGUAGES.indexOf(code) === -1) return false;
    if (code === currentLang) return false;
    currentLang = code;
    var buttons = langBar.querySelectorAll('.lang-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].dataset.lang === code);
    }
    return true;
  }

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
      btn.onclick = function() { setActiveLang(code); };
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
    // Closing the widget: stop any active recording, exit conversation loop,
    // and stop any TTS playback.
    if (!isOpen) {
      conversationMode = false;
      if (recording) { try { stopRecording(); } catch(_) {} }
      stopPlayback();
      if (vmActive) { void endVoiceMode(); }
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
  var conversationMode = false;   // true when we're in the record → reply → TTS → record loop
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

  /* Speaker toggle — turns voice replies on/off.
   * When ON: replies auto-play as TTS, and tapping mic enters a continuous
   * record → reply → speak → record conversation loop.
   * When OFF: back to text-only (plus one-shot voice messages via mic). */
  if (spk) {
    spk.onclick = function() {
      speakMode = !speakMode;
      spk.classList.toggle('on', speakMode);
      spk.title = speakMode ? 'Voice conversation mode on' : 'Voice conversation mode off';
      if (icoSpkOff && icoSpkOn) {
        icoSpkOff.style.display = speakMode ? 'none' : '';
        icoSpkOn.style.display = speakMode ? '' : 'none';
      }
      // If turning off, stop playback and exit the conversation loop
      if (!speakMode) {
        conversationMode = false;
        stopPlayback();
      }
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

  /* Mic button — toggle recording.
   * If the user taps mic while speaker is ON, this starts a continuous
   * voice conversation loop (record → reply → speak → record…).
   * Tapping mic a second time stops the current recording and cancels the loop. */
  if (mic) {
    mic.onclick = function() {
      if (recording) {
        // User pressed mic to stop — exit conversation loop too
        conversationMode = false;
        stopRecording();
        return;
      }
      // Entering conversation mode: user pressed mic AND speaker is on
      if (speakMode) conversationMode = true;
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
      // Whisper tells us which language the user spoke. If it's one of the
      // configured languages, switch to it so the bot replies in the same
      // language (and TTS uses that language's voicing).
      if (data && data.language) {
        setActiveLang(data.language);
      }
      ci.value = (data && data.text) || '';
      if (ci.value.trim()) {
        // Auto-resize and auto-send the transcribed message
        ci.style.height = 'auto';
        ci.style.height = Math.min(ci.scrollHeight, 100) + 'px';
        sendMessage();
      } else if (conversationMode && speakMode) {
        // Empty transcription while in conversation mode — re-listen instead of giving up
        setTimeout(function() { if (speakMode && conversationMode) startRecording(); }, 400);
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
      ci.placeholder = PLACEHOLDER;
      sb.disabled = !ci.value.trim();
    });
  }

  /* ── Unlock AudioContext on first user gesture ──────────────────────
   * Browsers block audio.play() unless the user has interacted.
   * We create an AudioContext on the first click anywhere and keep it alive.
   * Web Audio API's AudioContext bypasses most autoplay restrictions once
   * unlocked, and we use it for voice-mode TTS playback.
   * The speaker-toggle (speakReply) still uses HTMLAudio for simplicity
   * since it's triggered from a button click directly.
   * ─────────────────────────────────────────────────────────────────── */
  var audioCtxUnlocked = false;
  var sharedAudioCtx = null;

  function getAudioCtx() {
    if (!sharedAudioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) sharedAudioCtx = new AC();
      } catch (_) {}
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(function() {});
    }
    return sharedAudioCtx;
  }

  // Unlock on first interaction anywhere in the widget
  document.addEventListener('click', function unlockAudio() {
    if (audioCtxUnlocked) return;
    audioCtxUnlocked = true;
    getAudioCtx();
    document.removeEventListener('click', unlockAudio);
  }, { once: true });

  /* Play a base64 data URL via Web Audio API (works even after user gesture expires).
   * Falls back to HTMLAudio if AudioContext is unavailable. */
  function playDataUrlVoice(dataUrl, onEnded, onError) {
    var ctx = getAudioCtx();

    if (!ctx) {
      // Fallback: HTMLAudio (may be blocked by autoplay policy)
      var fallback = new Audio();
      fallback.src = dataUrl;
      fallback.onended = onEnded || function(){};
      fallback.onerror = onError || function(){};
      fallback.play().catch(function(err) {
        console.warn('[TTS] HTMLAudio fallback blocked:', err && err.message ? err.message : err);
        if (onError) onError(err);
      });
      return { stop: function() { try { fallback.pause(); } catch(_){} } };
    }

    // Strip the data URL prefix to get raw base64
    var base64 = dataUrl.split(',')[1];
    if (!base64) { if (onError) onError(new Error('empty data URL')); return { stop: function(){} }; }

    var binary = atob(base64);
    var buffer = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

    var stopped = false;
    var source = null;

    ctx.decodeAudioData(buffer.buffer, function(decoded) {
      if (stopped) return;
      source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = function() { if (!stopped) { stopped = true; if (onEnded) onEnded(); } };
      try { source.start(0); } catch(e) { if (onError) onError(e); }
    }, function(err) {
      if (onError) onError(err || new Error('decode failed'));
    });

    return {
      stop: function() {
        stopped = true;
        if (source) { try { source.stop(); } catch(_) {} source = null; }
      }
    };
  }

  // Track the current voice-mode audio handle (returned by playDataUrlVoice)
  var vmCurrentHandle = null;
  function blobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('FileReader failed')); };
      reader.readAsDataURL(blob);
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
      return blobToDataUrl(blob).then(function(dataUrl) {
        currentAudio = new Audio();
        currentAudio.src = dataUrl;
        if (spk) spk.classList.add('playing');
        currentAudio.onended = function() {
          if (spk) spk.classList.remove('playing');
          currentAudio = null;
          // Conversation loop: TTS just finished → auto-listen for the next message
          if (conversationMode && speakMode && !recording) {
            setTimeout(function() {
              if (conversationMode && speakMode && !recording) startRecording();
            }, 350);
          }
        };
        currentAudio.onerror = function(e) {
          if (spk) spk.classList.remove('playing');
          currentAudio = null;
          console.warn('TTS audio error:', e && e.message ? e.message : e);
          // Even if audio errored, try to continue the loop (fallback UX)
          if (conversationMode && speakMode && !recording) {
            setTimeout(function() {
              if (conversationMode && speakMode && !recording) startRecording();
            }, 350);
          }
        };
        currentAudio.play().catch(function(err) {
          console.warn('Audio play blocked:', err && err.message ? err.message : err);
          if (spk) spk.classList.remove('playing');
          conversationMode = false;
        });
      });
    })
    .catch(function(err) { console.warn('TTS fetch failed:', err && err.message ? err.message : err); });
  }
  /* ══════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════
   * VOICE CONVERSATION MODE — OpenAI Realtime API (sub-second)
   *
   * HOW IT WORKS:
   *   Browser mic → PCM16 audio → WebSocket to Railway proxy
   *   Railway proxy ↔ OpenAI Realtime API (one warm connection)
   *   OpenAI audio → WebSocket → Browser AudioContext plays it
   *
   *   Everything (VAD + STT + LLM + TTS) happens inside OpenAI.
   *   Latency: <500ms first audio vs 3-5s with old 3-step pipeline.
   *
   * FALLBACK:
   *   If REALTIME_WS_BASE is not configured or connection fails,
   *   falls back to the old Whisper+GPT+TTS pipeline automatically.
   * ══════════════════════════════════════════════════════════ */
  var vmActive = false;
  var vmWs = null;              // WebSocket to Railway proxy
  var vmMicStream = null;       // getUserMedia stream
  var vmAudioCtx = null;        // Web AudioContext (unlocked on user click)
  var vmScriptProc = null;      // ScriptProcessor node for mic capture
  var vmPlaybackNode = null;    // AudioBufferSourceNode for current playback
  var vmPlayQueue = [];         // [{buffer: AudioBuffer}] queue for ordered playback
  var vmPlaying = false;        // whether we are currently playing audio

  // ── UI helpers — must be defined before startVoiceMode ───────
  function vmSetPhase(phase, statusText, hintText) {
    if (vmOrb) {
      vmOrb.classList.remove('listening', 'speaking', 'thinking');
      if (phase === 'listening') vmOrb.classList.add('listening');
      else if (phase === 'speaking') vmOrb.classList.add('speaking');
      else if (phase === 'thinking') vmOrb.classList.add('thinking');
    }
    if (vmStatus && statusText != null) vmStatus.textContent = statusText;
    if (vmHint   && hintText   != null) vmHint.textContent   = hintText;
  }

  function vmLocalize(en, es) {
    return currentLang === 'es' ? es : en;
  }

  if (vmBtn) {
    vmBtn.onclick = function() {
      if (vmActive) { void endVoiceMode(); }
      else { void startVoiceMode(); }
    };
  }
  if (vmEnd) {
    vmEnd.onclick = function() { void endVoiceMode(); };
  }

  // Ensure AudioContext is unlocked on the same user click that starts voice mode
  function ensureAudioCtx() {
    if (!vmAudioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) vmAudioCtx = new AC();
    }
    if (vmAudioCtx && vmAudioCtx.state === 'suspended') {
      vmAudioCtx.resume().catch(function() {});
    }
    return vmAudioCtx;
  }

  async function startVoiceMode() {
    if (vmActive) return;

    // Check if Realtime proxy is available
    if (!REALTIME_WS_BASE) {
      // No WS server configured — fall through to old VAD voice mode
      showToast('Real-time voice not configured. Using standard voice mode.', false);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addBotMsg('Your browser does not support microphone access. Please use Chrome or Firefox.');
      return;
    }

    vmActive = true;
    if (vMode) vMode.classList.add('on');
    if (vmLangEl) vmLangEl.textContent = (currentLang || 'en').toUpperCase();
    vmSetPhase('idle', vmLocalize('Connecting…', 'Conectando…'), '');

    // Get mic — must be done from user gesture (this click)
    var micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      vmActive = false;
      if (vMode) vMode.classList.remove('on');
      addBotMsg(vmLocalize('Microphone access denied. Please allow microphone and try again.', 'Acceso al micrófono denegado. Permite el acceso e inténtalo de nuevo.'));
      return;
    }
    vmMicStream = micStream;

    // Unlock AudioContext from this user gesture
    var actx = ensureAudioCtx();

    // Open WebSocket to Railway proxy
    var wsUrl = REALTIME_WS_BASE + '/realtime?chatbotId=' + encodeURIComponent(CID);
    try {
      vmWs = new WebSocket(wsUrl);
      vmWs.binaryType = 'arraybuffer';
    } catch (err) {
      vmActive = false;
      if (vMode) vMode.classList.remove('on');
      cleanupMic();
      addBotMsg(vmLocalize('Could not connect to voice service. Please try again.', 'No se pudo conectar al servicio de voz. Inténtalo de nuevo.'));
      return;
    }

    vmWs.onopen = function() {
      vmSetPhase('listening',
        vmLocalize('Listening… speak now', 'Escuchando… habla ahora'),
        vmLocalize('I will respond instantly when you pause.', 'Responderé instantáneamente cuando hagas pausa.')
      );
      // Start streaming mic audio
      startMicCapture(micStream, actx);
    };

    vmWs.onmessage = function(event) {
      if (!vmActive) return;

      // Binary message = audio chunk from OpenAI TTS
      if (event.data instanceof ArrayBuffer) {
        queueAudioChunk(event.data, actx);
        return;
      }

      // JSON message = event from proxy or OpenAI
      var msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'session.ready') {
        vmSetPhase('listening',
          vmLocalize('Listening… speak now', 'Escuchando… habla ahora'),
          vmLocalize('I will respond instantly when you pause.', 'Responderé instantáneamente cuando hagas pausa.')
        );
      }

      // VAD detected speech start — update UI
      if (msg.type === 'input_audio_buffer.speech_started') {
        stopPlayback();
        vmSetPhase('listening',
          vmLocalize('Listening…', 'Escuchando…'),
          ''
        );
      }

      // VAD detected speech end — OpenAI is now thinking
      if (msg.type === 'input_audio_buffer.speech_stopped' || msg.type === 'input_audio_buffer.committed') {
        vmSetPhase('thinking',
          vmLocalize('Thinking…', 'Pensando…'),
          ''
        );
      }

      // AI is generating and sending audio
      if (msg.type === 'response.audio.delta' || msg.type === 'response.created') {
        vmSetPhase('speaking',
          vmLocalize('Speaking…', 'Hablando…'),
          vmLocalize('Tap "End conversation" to stop.', 'Toca "Finalizar" para detener.')
        );
      }

      // AI turn complete — go back to listening
      if (msg.type === 'response.done' || msg.type === 'response.audio.done') {
        // Let any queued audio finish, then go back to listening
        waitForPlaybackDone(function() {
          if (vmActive) {
            vmSetPhase('listening',
              vmLocalize('Listening…', 'Escuchando…'),
              vmLocalize('I will respond instantly when you pause.', 'Responderé instantáneamente cuando hagas pausa.')
            );
          }
        });
      }

      // Transcript from user (from Whisper inside Realtime API)
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        var userText = msg.transcript || '';
        if (userText.trim()) addUserMsg(userText.trim());
      }

      // Transcript from AI
      if (msg.type === 'response.audio_transcript.done') {
        var aiText = parseAndCaptureLeadFromText(msg.transcript || '');
        if (aiText.trim()) addBotMsg(aiText.trim());
      }

      // Error from proxy or OpenAI
      if (msg.type === 'error') {
        var errMsg = (msg.error && msg.error.message) || msg.message || 'Voice service error.';
        console.warn('[vmWs] error:', errMsg);
        // If session-level error, try to continue; if fatal, end
        if (errMsg.includes('not found') || errMsg.includes('configuration')) {
          void endVoiceMode();
        }
      }
    };

    vmWs.onerror = function(e) {
      console.warn('[vmWs] WebSocket error:', e);
    };

    vmWs.onclose = function(code) {
      console.log('[vmWs] closed:', code);
      if (vmActive) {
        vmActive = false;
        cleanupMic();
        if (vMode) vMode.classList.remove('on');
        if (code !== 1000) {
          addBotMsg(vmLocalize('Voice connection lost. Please try again.', 'Conexión de voz perdida. Inténtalo de nuevo.'));
        }
      }
    };
  }

  async function endVoiceMode() {
    if (!vmActive && !(vMode && vMode.classList.contains('on'))) return;
    vmActive = false;
    stopPlayback();
    cleanupMic();
    if (vmWs) {
      try { vmWs.send(JSON.stringify({ type: 'session.end' })); } catch (_) {}
      try { vmWs.close(1000); } catch (_) {}
      vmWs = null;
    }
    vmSetPhase('idle', '', '');
    if (vMode) vMode.classList.remove('on');
    vmPlayQueue = [];
    vmPlaying = false;
  }

  // ── Mic capture → PCM16 → WebSocket ──────────────────────────
  // OpenAI Realtime API requires: PCM16 audio, 24kHz, mono.
  // We use ScriptProcessorNode to capture float32 from mic,
  // convert to int16, and send raw binary over WebSocket.
  function startMicCapture(stream, actx) {
    if (!actx) return;
    try {
      var source = actx.createMediaStreamSource(stream);
      var bufSize = 4096;
      var proc = actx.createScriptProcessor(bufSize, 1, 1);

      proc.onaudioprocess = function(e) {
        if (!vmActive || !vmWs || vmWs.readyState !== 1) return;
        var f32 = e.inputBuffer.getChannelData(0);

        // Resample from mic sample rate to 24kHz if needed
        var targetRate = 24000;
        var srcRate = actx.sampleRate;
        var resampled = f32;
        if (srcRate !== targetRate) {
          var ratio = srcRate / targetRate;
          var outLen = Math.round(f32.length / ratio);
          var out = new Float32Array(outLen);
          for (var i = 0; i < outLen; i++) {
            out[i] = f32[Math.min(Math.round(i * ratio), f32.length - 1)];
          }
          resampled = out;
        }

        // Convert float32 → int16
        var int16 = new Int16Array(resampled.length);
        for (var j = 0; j < resampled.length; j++) {
          var s = Math.max(-1, Math.min(1, resampled[j]));
          int16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Wrap in OpenAI input_audio_buffer.append event
        // The Realtime API accepts either raw binary (audio bytes only)
        // or JSON events. We send JSON to keep the message type clear.
        var b64 = arrayBufferToBase64(int16.buffer);
        try {
          vmWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: b64,
          }));
        } catch (_) {}
      };

      source.connect(proc);
      proc.connect(actx.destination);
      vmScriptProc = proc;

    } catch (err) {
      console.warn('[vm] mic capture setup failed:', err.message);
    }
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ── Audio playback: PCM16 from OpenAI → AudioContext ─────────
  // OpenAI Realtime API sends back PCM16 24kHz mono audio chunks.
  // We decode them and play sequentially through the AudioContext.
  function queueAudioChunk(arrayBuffer, actx) {
    if (!actx || !arrayBuffer || arrayBuffer.byteLength === 0) return;
    // Convert PCM16 → float32 → AudioBuffer
    var int16 = new Int16Array(arrayBuffer);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }
    var audioBuffer = actx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);
    vmPlayQueue.push(audioBuffer);
    if (!vmPlaying) playNextChunk(actx);
  }

  function playNextChunk(actx) {
    if (!vmActive || vmPlayQueue.length === 0) { vmPlaying = false; return; }
    vmPlaying = true;
    var buf = vmPlayQueue.shift();
    var src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    src.onended = function() { playNextChunk(actx); };
    src.start();
    vmPlaybackNode = src;
  }

  function stopPlayback() {
    vmPlayQueue = [];
    vmPlaying = false;
    if (vmPlaybackNode) {
      try { vmPlaybackNode.stop(); } catch (_) {}
      vmPlaybackNode = null;
    }
  }

  function waitForPlaybackDone(cb) {
    if (!vmPlaying && vmPlayQueue.length === 0) { cb(); return; }
    var check = setInterval(function() {
      if (!vmPlaying && vmPlayQueue.length === 0) { clearInterval(check); cb(); }
    }, 100);
  }

  function cleanupMic() {
    if (vmScriptProc) { try { vmScriptProc.disconnect(); } catch (_) {} vmScriptProc = null; }
    if (vmMicStream) { try { vmMicStream.getTracks().forEach(function(t) { t.stop(); }); } catch (_) {} vmMicStream = null; }
    if (vmAudioCtx) { try { vmAudioCtx.close(); } catch (_) {} vmAudioCtx = null; }
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

      // Support both old format (bare array) and new format ({ts, history})
      var savedAt = 0;
      var list = null;
      if (Array.isArray(saved)) {
        list = saved;
        savedAt = 0; // legacy — don't expire
      } else if (saved && typeof saved === 'object') {
        savedAt = saved.ts || 0;
        list = Array.isArray(saved.history) ? saved.history : null;
      }
      if (!Array.isArray(list)) return;

      // Idle TTL: if last activity was more than 10 minutes ago, wipe.
      if (savedAt && (Date.now() - savedAt) > IDLE_TTL_MS) {
        sessionStorage.removeItem(SESS_KEY);
        return;
      }

      list.forEach(function(m) {
        if (m.role && m.text) {
          if (m.role === 'model') { history.push({ role: 'model', text: m.text }); addMsg('bot', m.text, true); }
          else { history.push({ role: 'user', text: m.text }); addMsg('usr', m.text, true); }
        }
      });
      greeted = true;
    } catch(e) {}
  }

  function saveSession() {
    try {
      sessionStorage.setItem(SESS_KEY, JSON.stringify({
        ts: Date.now(),
        history: history.slice(-40),
      }));
    } catch(e) {}
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
    .finally(function() { sending = false; ci.focus(); maybeTriggerLeadCapture(); });
  }

  /* ══════════════════════════════════════════════════════════
   * LEAD CAPTURE
   * In-chat form for text mode + spoken capture for voice mode.
   * Only runs when COLLECT_LEADS = true and lead not yet captured.
   * Lead state lives in sessionStorage (browser-side, no server storage).
   * ══════════════════════════════════════════════════════════ */
  var leadFormVisible = false;
  var leadAttempts = 0;
  var MAX_LEAD_ATTEMPTS = 2; // don't pester users — try twice, then give up

  function leadAlreadyCaptured() {
    try { return sessionStorage.getItem(LEAD_CAPTURED_KEY) === 'true'; }
    catch (_) { return false; }
  }

  function markLeadCaptured() {
    try { sessionStorage.setItem(LEAD_CAPTURED_KEY, 'true'); } catch (_) {}
  }

  function leadL10n(key) {
    var dict = {
      en: {
        ask: "To serve you better, may I have your details? Just your name and either an email or phone number would be perfect.",
        title: "Quick details",
        hint: "Name and one of email or phone is required.",
        name: "Name *",
        phone: "Phone",
        email: "Email",
        submit: "Save details",
        skip: "Maybe later",
        thanks: "Thanks! How else can I help?",
        needName: "Please enter your name.",
        needContact: "Please enter a phone number or email.",
        invalidEmail: "That email doesn't look right.",
        savedFail: "Couldn't save those details — please try again.",
        textDisabled: "Please complete the form above to continue.",
      },
      es: {
        ask: "Para atenderte mejor, ¿puedo pedirte tus datos? Solo tu nombre y un correo o teléfono.",
        title: "Datos rápidos",
        hint: "Nombre y uno de correo o teléfono son obligatorios.",
        name: "Nombre *",
        phone: "Teléfono",
        email: "Correo",
        submit: "Guardar datos",
        skip: "Quizá más tarde",
        thanks: "¡Gracias! ¿En qué más puedo ayudarte?",
        needName: "Por favor ingresa tu nombre.",
        needContact: "Por favor ingresa un teléfono o correo.",
        invalidEmail: "Ese correo no se ve correcto.",
        savedFail: "No pude guardar los datos — inténtalo de nuevo.",
        textDisabled: "Por favor completa el formulario para continuar.",
      },
    };
    return (dict[currentLang] || dict.en)[key];
  }

  function setInputDisabledByLead(disabled) {
    if (!ci) return;
    ci.disabled = disabled;
    sb.disabled = disabled || !ci.value.trim();
    if (mic) mic.disabled = disabled;
    ci.placeholder = disabled ? leadL10n('textDisabled') : PLACEHOLDER;
  }

  function maybeTriggerLeadCapture() {
    if (!COLLECT_LEADS) return;
    if (leadAlreadyCaptured()) return;
    if (leadFormVisible) return;
    if (vmActive) return; // voice-mode handles its own capture
    if (leadAttempts >= MAX_LEAD_ATTEMPTS) return;

    // Wait until we've had a real exchange (greeting + at least one user msg + one bot reply)
    var userMsgs = history.filter(function(m){ return m.role === 'user'; }).length;
    var botMsgs = history.filter(function(m){ return m.role === 'model'; }).length;
    if (userMsgs < 1 || botMsgs < 2) return;

    leadAttempts++;
    setTimeout(function() {
      addBotMsg(leadL10n('ask'));
      renderLeadForm();
    }, 600);
  }

  function renderLeadForm() {
    if (leadFormVisible || leadAlreadyCaptured()) return;
    leadFormVisible = true;
    setInputDisabledByLead(true);

    var form = document.createElement('div');
    form.className = 'leadForm';
    form.id = 'leadForm';
    form.innerHTML =
      '<div class="lfTitle">' +
        '<svg class="lfIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
        '<span>' + leadL10n('title') + '</span>' +
      '</div>' +
      '<div class="lfHint">' + leadL10n('hint') + '</div>' +
      '<div class="lfField">' +
        '<label class="lfLabel">' + leadL10n('name') + '</label>' +
        '<input class="lfInput" id="lfName" type="text" autocomplete="name" />' +
      '</div>' +
      '<div class="lfRow">' +
        '<div class="lfField">' +
          '<label class="lfLabel">' + leadL10n('phone') + '</label>' +
          '<input class="lfInput" id="lfPhone" type="tel" autocomplete="tel" />' +
        '</div>' +
        '<div class="lfField">' +
          '<label class="lfLabel">' + leadL10n('email') + '</label>' +
          '<input class="lfInput" id="lfEmail" type="email" autocomplete="email" />' +
        '</div>' +
      '</div>' +
      '<div class="lfError" id="lfError"></div>' +
      '<div class="lfActions">' +
        '<button class="lfSkip" type="button" id="lfSkip">' + leadL10n('skip') + '</button>' +
        '<button class="lfSubmit" type="button" id="lfSubmit">' + leadL10n('submit') + '</button>' +
      '</div>';

    msgs.appendChild(form);
    msgs.scrollTop = msgs.scrollHeight;

    var nameEl = form.querySelector('#lfName');
    var phoneEl = form.querySelector('#lfPhone');
    var emailEl = form.querySelector('#lfEmail');
    var errEl = form.querySelector('#lfError');
    var submitBtn = form.querySelector('#lfSubmit');
    var skipBtn = form.querySelector('#lfSkip');

    setTimeout(function() { try { nameEl.focus(); } catch(_) {} }, 100);

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.classList.add('show');
    }
    function clearErr() { errEl.classList.remove('show'); }

    function validateAndSubmit() {
      clearErr();
      var name = (nameEl.value || '').trim();
      var phone = (phoneEl.value || '').trim();
      var email = (emailEl.value || '').trim();

      if (!name) {
        nameEl.classList.add('invalid');
        showErr(leadL10n('needName'));
        return;
      }
      nameEl.classList.remove('invalid');

      if (!phone && !email) {
        phoneEl.classList.add('invalid');
        emailEl.classList.add('invalid');
        showErr(leadL10n('needContact'));
        return;
      }
      phoneEl.classList.remove('invalid');
      emailEl.classList.remove('invalid');

      if (email && !/.+@.+\\..+/.test(email)) {
        emailEl.classList.add('invalid');
        showErr(leadL10n('invalidEmail'));
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '…';

      fetch(API + '/api/chatbot-public/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatbotId: CID,
          name: name,
          phone: phone,
          email: email,
        }),
      })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(j) { throw new Error((j && j.error && j.error.message) || 'failed'); });
        return r.json();
      })
      .then(function() {
        markLeadCaptured();
        form.classList.add('submitted');
        leadFormVisible = false;
        setInputDisabledByLead(false);
        addBotMsg(leadL10n('thanks'));
      })
      .catch(function(err) {
        submitBtn.disabled = false;
        submitBtn.textContent = leadL10n('submit');
        showErr(err.message || leadL10n('savedFail'));
      });
    }

    submitBtn.onclick = validateAndSubmit;
    skipBtn.onclick = function() {
      form.remove();
      leadFormVisible = false;
      setInputDisabledByLead(false);
    };

    // Enter on any field submits
    [nameEl, phoneEl, emailEl].forEach(function(el) {
      el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); validateAndSubmit(); }
      });
    });
  }

  /* Voice-mode lead capture — invoked from streamAndSpeak when token detected.
   * The system prompt (built server-side) is augmented to instruct the model:
   * after greeting + first answer, ask for the visitor's name + email/phone,
   * read it back for confirmation, and on confirmation emit a token like:
   *   [CAPTURE_LEAD: name=Jane Doe; phone=+1234567890; email=jane@x.com]
   * The widget regex-matches this token in the streamed text, strips it
   * before TTS, and POSTs the parsed values to /capture-lead. */
  function parseAndCaptureLeadFromText(text) {
    if (!COLLECT_LEADS || leadAlreadyCaptured() || !text) return text;
    var re = /\\[CAPTURE_LEAD:\\s*([^\\]]+)\\]/i;
    var m = text.match(re);
    if (!m) return text;
    var payload = m[1] || '';
    var name = '', phone = '', email = '';
    payload.split(/[;,]/).forEach(function(part) {
      var kv = part.split('=');
      if (kv.length < 2) return;
      var k = kv[0].trim().toLowerCase();
      var v = kv.slice(1).join('=').trim();
      if (k === 'name') name = v;
      else if (k === 'phone') phone = v;
      else if (k === 'email') email = v;
    });
    if (name && (phone || email)) {
      fetch(API + '/api/chatbot-public/capture-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatbotId: CID, name: name, phone: phone, email: email }),
      })
      .then(function(r) { if (r.ok) markLeadCaptured(); })
      .catch(function() {});
    }
    // Strip the token from the text we display / speak
    return text.replace(re, '').trim();
  }
  /* ══════════════════════════════════════════════════════════ */

})();
</script>
</body>
</html>`;
}

module.exports = router;
