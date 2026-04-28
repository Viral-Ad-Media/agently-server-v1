"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
let assistantIntel = null;
try {
  assistantIntel = require("../../lib/assistant-intelligence");
} catch (_) {
  assistantIntel = null;
}

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

    // Resolve agent name for the lead tag and server-built voice prompt.
    let agentName = chatbot.name || chatbot.header_title || "Assistant";
    if (chatbot.voice_agent_id) {
      try {
        const { data: agent } = await db
          .from("voice_agents")
          .select("name")
          .eq("id", chatbot.voice_agent_id)
          .single();
        if (agent && agent.name) agentName = agent.name;
      } catch (_) {}
    }

    let voiceSystemPrompt = "";
    if (
      assistantIntel &&
      assistantIntel.loadChatbotContext &&
      assistantIntel.buildAssistantPrompt
    ) {
      try {
        const context = await assistantIntel.loadChatbotContext(id);
        voiceSystemPrompt = assistantIntel.buildAssistantPrompt({
          context,
          message: "voice conversation",
          mode: "voice",
          direction: "chat",
          languageName: "English",
        });
      } catch (e) {
        console.warn(
          "[widget] voice prompt build failed:",
          e && e.message ? e.message : e,
        );
      }
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
      realtimeWsUrl: safeStr(
        (process.env.TWILIO_WS_URL || "")
          .trim()
          .replace(/\/ws$/, "")
          .replace(/\/$/, ""),
      ),
      collectLeads: chatbot.collect_leads !== false,
      agentName: safeStr(agentName),
      voiceSystemPrompt: safeStr(voiceSystemPrompt),
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self' https: wss:;",
    );
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
#sb{background:var(--a);color:#fff;border:none;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:opacity .2s,transform .15s;}
#sb:hover{opacity:.88;transform:scale(1.04)}
#sb:active{transform:scale(.96)}
#sb:disabled{opacity:.45;cursor:not-allowed;transform:none}
.pw{text-align:center;font-size:10.5px;color:#94a3b8;padding:5px 14px 7px;background:#fff;border-top:1px solid #f1f5f9;flex-shrink:0;letter-spacing:.01em;}
.pw a{color:var(--a);text-decoration:none;font-weight:600}
.pw a:hover{text-decoration:underline}

#vMode{position:absolute;inset:0;background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);display:none;flex-direction:column;align-items:center;justify-content:space-between;padding:32px 24px;z-index:10;color:#fff;}
#vMode.on{display:flex}
.vmTop{display:flex;align-items:center;justify-content:space-between;width:100%;}
.vmLabel{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.5)}
.vmLang{font-size:11px;color:rgba(255,255,255,.6);padding:4px 10px;border:1px solid rgba(255,255,255,.15);border-radius:999px;}
.vmCenter{display:flex;flex-direction:column;align-items:center;gap:20px;flex:1;justify-content:center}
.vmOrb{width:140px;height:140px;border-radius:50%;background:radial-gradient(circle at 30% 30%,var(--a) 0%,var(--ad,#4f46e5cc) 60%,rgba(0,0,0,.3) 100%);box-shadow:0 0 60px var(--a);transition:transform .1s ease-out;}
.vmOrb.listening{animation:orbBreath 1.8s ease-in-out infinite}
.vmOrb.speaking{animation:orbSpeak .9s ease-in-out infinite}
.vmOrb.thinking{animation:orbSpin 1.4s linear infinite}
@keyframes orbBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes orbSpeak{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes orbSpin{0%{transform:rotate(0) scale(.96)}50%{transform:rotate(180deg) scale(1.02)}100%{transform:rotate(360deg) scale(.96)}}
.vmStatus{font-size:16px;font-weight:600;color:rgba(255,255,255,.95);text-align:center;min-height:22px;}
.vmHint{font-size:12px;color:rgba(255,255,255,.45);text-align:center;max-width:260px;line-height:1.5}
.vmActions{display:flex;gap:10px;width:100%;justify-content:center;}
.vmBtn{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.15);padding:10px 18px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.vmBtn.vmEnd{background:#dc2626;border-color:#dc2626}
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

#mic{background:#fff;border:1.5px solid #e2e8f0;color:#64748b;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all .2s;}
#mic:hover{border-color:var(--a);color:var(--a);background:var(--al)}
#mic:disabled{opacity:.45;cursor:not-allowed}
#mic.recording{background:var(--a);color:#fff;border-color:var(--a);animation:recPulse 1.1s ease-in-out infinite;}
@keyframes recPulse{0%,100%{box-shadow:0 0 0 0 rgba(79,70,229,.55)}50%{box-shadow:0 0 0 8px rgba(79,70,229,0)}}
#recBar{flex:1;display:none;align-items:center;gap:10px;padding:10px 13px;border:1.5px solid var(--a);border-radius:12px;background:var(--al);color:var(--a);font-size:13px;font-weight:600;min-height:42px;}
#recBar.on{display:flex}
#recBar .dotRed{width:9px;height:9px;background:var(--a);border-radius:50%;animation:pulse 1.2s infinite;flex-shrink:0}
#recBar .recWave{display:flex;align-items:center;gap:2px;flex:1;height:18px;}
#recBar .recWave span{display:block;width:3px;background:var(--a);border-radius:2px;animation:wave 1s ease-in-out infinite;}
#recBar .recWave span:nth-child(1){animation-delay:-.9s}#recBar .recWave span:nth-child(2){animation-delay:-.75s}#recBar .recWave span:nth-child(3){animation-delay:-.6s}#recBar .recWave span:nth-child(4){animation-delay:-.45s}#recBar .recWave span:nth-child(5){animation-delay:-.3s}#recBar .recWave span:nth-child(6){animation-delay:-.15s}#recBar .recWave span:nth-child(7){animation-delay:0s}
@keyframes wave{0%,100%{height:5px}50%{height:18px}}
#recBar .recTime{font-variant-numeric:tabular-nums;color:var(--a);opacity:.8;font-size:12px;flex-shrink:0}
#spk{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.6;transition:opacity .2s,background .2s;}
#spk:hover{opacity:1;background:rgba(255,255,255,.15)}
#spk.on{opacity:1;background:rgba(255,255,255,.2)}
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
  <div id="vMode" role="dialog" aria-label="Voice conversation">
    <div class="vmTop"><span class="vmLabel">Voice Mode</span><span class="vmLang" id="vmLang">EN</span></div>
    <div class="vmCenter">
      <div class="vmOrb" id="vmOrb"></div>
      <div class="vmStatus" id="vmStatus">Tap to start speaking</div>
      <div class="vmHint" id="vmHint">Speak naturally. I will reply instantly when you pause.</div>
    </div>
    <div class="vmActions">
      <button class="vmBtn vmEnd" id="vmEnd" type="button">End conversation</button>
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
  var FAQS = ${cfg.faqs};
  var PROMPTS = ${cfg.suggestedPrompts};
  var LANGUAGES = ${cfg.chatLanguages};
  var CHAT_VOICE = '${cfg.chatVoice}';
  var REALTIME_WS_BASE = '${cfg.realtimeWsUrl}';
  var COLLECT_LEADS = ${cfg.collectLeads};
  var STORAGE_KEY = 'agently:' + CID;
  var IDLE_TTL_MS = 5 * 60 * 1000; // Clear local widget chat cache only after the widget has been closed for 5 minutes
  var LEAD_CAPTURED_KEY = 'agently:' + CID + ':leadCaptured';
  var AGENT_NAME = '${cfg.agentName}';
  var VOICE_SYSTEM_PROMPT = '${cfg.voiceSystemPrompt}';
  var LANG_NAMES = ${JSON.stringify(LANG_NAMES)};

  var currentLang = LANGUAGES[0] || 'en';
  var isOpen = false;
  var greeted = false;
  var sending = false;
  var history = [];
  var closeClearTimer = null;

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
    if (isOpen) {
      if (closeClearTimer) { clearTimeout(closeClearTimer); closeClearTimer = null; }
      if (!sessionLoaded) { sessionLoaded = true; loadSession(); }
      if (!greeted) { greeted = true; setTimeout(function() { addBotMsg(WELCOME); }, 200); }
      setTimeout(function() { ci.focus(); }, 250);
    } else {
      scheduleSessionClear();
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

  function storageGet(k) {
    try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch(e) { return null; }
  }
  function storageSet(k, v) {
    try { localStorage.setItem(k, v); } catch(e) {}
    try { sessionStorage.setItem(k, v); } catch(e) {}
  }
  function storageRemove(k) {
    try { localStorage.removeItem(k); } catch(e) {}
    try { sessionStorage.removeItem(k); } catch(e) {}
  }

  function clearSessionCache() {
    storageRemove(SESS_KEY);
  }

  function scheduleSessionClear() {
    var closedAt = Date.now();
    try {
      storageSet(SESS_KEY, JSON.stringify({ ts: Date.now(), closedAt: closedAt, messages: history.slice(-24) }));
    } catch(e) {}
    if (closeClearTimer) clearTimeout(closeClearTimer);
    closeClearTimer = setTimeout(function() {
      try {
        var raw = storageGet(SESS_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && parsed.closedAt && Date.now() - Number(parsed.closedAt) >= IDLE_TTL_MS) {
          clearSessionCache();
          history = [];
          msgs.innerHTML = '';
          greeted = false;
          sessionLoaded = false;
        }
      } catch(e) { clearSessionCache(); }
    }, IDLE_TTL_MS + 200);
  }

  function loadSession() {
    try {
      var raw = storageGet(SESS_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var saved = Array.isArray(parsed) ? parsed : parsed.messages;
      var closedAt = Array.isArray(parsed) ? 0 : Number(parsed.closedAt || 0);
      if (closedAt && Date.now() - closedAt > IDLE_TTL_MS) {
        clearSessionCache();
        return;
      }
      if (!Array.isArray(saved)) { clearSessionCache(); return; }
      if (closedAt) { parsed.closedAt = 0; storageSet(SESS_KEY, JSON.stringify(parsed)); }
      saved.forEach(function(m) {
        if (m.role && m.text) {
          if (m.role === 'model') { history.push({ role: 'model', text: m.text }); addMsg('bot', m.text, true); }
          else { history.push({ role: 'user', text: m.text }); addMsg('usr', m.text, true); }
        }
      });
      greeted = history.length > 0;
    } catch(e) { clearSessionCache(); }
  }

  function saveSession() {
    try { storageSet(SESS_KEY, JSON.stringify({ ts: Date.now(), closedAt: 0, messages: history.slice(-24) })); } catch(e) {}
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
    if (COLLECT_LEADS && !leadAlreadyCaptured()) { renderLeadForm(); return; }
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
      setTimeout(function() { hideTyping(); addBotMsg(local); sending = false; ci.focus(); }, 500);
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
      addBotMsg(reply); speakReply(reply);
    })
    .catch(function() {
      hideTyping();
      addBotMsg("Sorry, I'm having trouble connecting right now. Please try again in a moment.");
    })
    .finally(function() { sending = false; ci.focus(); maybeTriggerLeadCapture(); });
  }





  /* ── Speaker toggle + Mic recording + TTS (text-mode voice features) ── */
  var speakMode = false;
  var recording = false;
  var mediaRecorder = null;
  var audioChunks = [];
  var mediaStream = null;
  var recStart = 0;
  var recTimer = null;
  var currentAudio = null;
  var spk = document.getElementById('spk');
  var icoSpkOff = document.getElementById('ico-spk-off');
  var icoSpkOn  = document.getElementById('ico-spk-on');
  var mic = document.getElementById('mic');
  var recBar = document.getElementById('recBar');
  var recTime = document.getElementById('recTime');
  var hasMediaRecorder = typeof window.MediaRecorder !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  if (!hasMediaRecorder && mic) mic.style.display = 'none';

  if (spk) {
    spk.onclick = function() {
      speakMode = !speakMode;
      spk.classList.toggle('on', speakMode);
      spk.title = speakMode ? 'Voice replies on' : 'Voice replies off';
      if (icoSpkOff) icoSpkOff.style.display = speakMode ? 'none' : '';
      if (icoSpkOn)  icoSpkOn.style.display  = speakMode ? '' : 'none';
      if (!speakMode) stopTTSPlayback();
    };
  }

  function stopTTSPlayback() {
    if (currentAudio) { try { currentAudio.pause(); } catch(_){} currentAudio = null; }
    if (spk) spk.classList.remove('playing');
  }

  function pickMimeType() {
    var c = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg'];
    for (var i = 0; i < c.length; i++) { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i]; }
    return '';
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms/1000), m = Math.floor(s/60); s = s%60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function setRecUI(on) {
    recording = on;
    if (mic) mic.classList.toggle('recording', on);
    if (ci)  ci.style.display = on ? 'none' : '';
    if (recBar) recBar.classList.toggle('on', on);
    if (on) {
      recStart = Date.now();
      if (recTime) recTime.textContent = '0:00';
      recTimer = setInterval(function() { if (recTime) recTime.textContent = fmtDuration(Date.now()-recStart); }, 250);
    } else {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
    }
  }

  if (mic) {
    mic.onclick = function() {
      if (recording) { stopRecording(); return; }
      startRecording();
    };
  }

  function startRecording() {
    if (!hasMediaRecorder) return;
    stopTTSPlayback();
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        mediaStream = stream;
        audioChunks = [];
        var mimeType = pickMimeType();
        try { mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream); }
        catch(err) { console.error('MediaRecorder init failed', err); cleanupStream(); return; }
        mediaRecorder.ondataavailable = function(e) { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = function() {
          setRecUI(false);
          var blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
          cleanupStream();
          if (blob.size < 500) return;
          void transcribeAndFill(blob);
        };
        mediaRecorder.start();
        setRecUI(true);
      })
      .catch(function(err) {
        console.error('Mic denied', err);
        addBotMsg('I need microphone access to record. Please allow access and try again.');
      });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch(_){} }
    else { setRecUI(false); cleanupStream(); }
  }

  function cleanupStream() {
    if (mediaStream) { try { mediaStream.getTracks().forEach(function(t){t.stop();}); } catch(_){} mediaStream = null; }
  }

  function transcribeAndFill(blob) {
    if (ci) { ci.disabled = true; ci.placeholder = 'Transcribing...'; }
    if (sb) sb.disabled = true;
    if (mic) mic.disabled = true;
    return fetch(API + '/api/chatbot-public/transcribe?chatbotId=' + encodeURIComponent(CID), {
      method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob,
    })
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('Transcription failed')); })
    .then(function(data) {
      if (ci) ci.value = (data && data.text) || '';
      if (ci && ci.value.trim()) {
        ci.style.height = 'auto';
        ci.style.height = Math.min(ci.scrollHeight, 100) + 'px';
        sendMessage();
      }
    })
    .catch(function(err) {
      console.error('Transcribe error', err);
      addBotMsg("I couldn't transcribe that audio. Please try again.");
    })
    .finally(function() {
      if (ci) { ci.disabled = false; ci.placeholder = PLACEHOLDER; }
      if (mic) mic.disabled = false;
      if (sb) sb.disabled = !(ci && ci.value.trim());
    });
  }

  function speakReply(text) {
    if (!speakMode || !text) return;
    stopTTSPlayback();
    fetch(API + '/api/chatbot-public/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, chatbotId: CID }),
    })
    .then(function(r) { return r.ok ? r.blob() : null; })
    .then(function(blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      if (spk) spk.classList.add('playing');
      currentAudio.onended = function() { if (spk) spk.classList.remove('playing'); URL.revokeObjectURL(url); currentAudio = null; };
      currentAudio.onerror = function() { if (spk) spk.classList.remove('playing'); currentAudio = null; };
      currentAudio.play().catch(function(err) {
        console.warn('Audio play blocked:', err && err.message ? err.message : err);
        if (spk) spk.classList.remove('playing');
      });
    })
    .catch(function(err) { console.warn('TTS failed:', err && err.message ? err.message : err); });
  }

  /* ── Lead Capture ──────────────────────────────────────────── */
  var leadFormVisible = false;
  var leadAttempts = 0;
  var MAX_LEAD_ATTEMPTS = 3;

  function leadAlreadyCaptured() {
    try { return sessionStorage.getItem(LEAD_CAPTURED_KEY) === 'true' || localStorage.getItem(LEAD_CAPTURED_KEY) === 'true'; } catch(_) { return false; }
  }
  function markLeadCaptured() {
    try { sessionStorage.setItem(LEAD_CAPTURED_KEY, 'true'); localStorage.setItem(LEAD_CAPTURED_KEY, 'true'); } catch(_) {}
  }

  function maybeTriggerLeadCapture() {
    if (!COLLECT_LEADS || leadAlreadyCaptured() || leadFormVisible || vmActive) return;
    if (leadAttempts >= MAX_LEAD_ATTEMPTS) return;
    var userMsgs = history.filter(function(m){ return m.role === 'user'; }).length;
    var botMsgs  = history.filter(function(m){ return m.role === 'model'; }).length;
    if (userMsgs < 1 || botMsgs < 2) return;
    leadAttempts++;
    setTimeout(function() { addBotMsg('To serve you better, may I get your name and contact details (phone or email)?'); renderLeadForm(); }, 600);
  }

  function renderLeadForm() {
    if (leadFormVisible || leadAlreadyCaptured()) return;
    leadFormVisible = true;
    ci.disabled = true; sb.disabled = true;
    var form = document.createElement('div');
    form.className = 'leadForm'; form.id = 'leadForm';
    form.innerHTML = '<div class="lfTitle">Quick details</div>'
      + '<div class="lfHint">Name and one of email or phone is required.</div>'
      + '<div class="lfField"><label class="lfLabel">Name *</label><input class="lfInput" id="lfName" type="text" autocomplete="name"/></div>'
      + '<div class="lfRow"><div class="lfField"><label class="lfLabel">Phone</label><input class="lfInput" id="lfPhone" type="tel"/></div>'
      + '<div class="lfField"><label class="lfLabel">Email</label><input class="lfInput" id="lfEmail" type="email"/></div></div>'
      + '<div class="lfError" id="lfError"></div>'
      + '<div class="lfActions"><button class="lfSubmit" type="button" id="lfSubmit">Save details</button></div>';
    msgs.appendChild(form); msgs.scrollTop = msgs.scrollHeight;
    var nEl = form.querySelector('#lfName'), pEl = form.querySelector('#lfPhone');
    var eEl = form.querySelector('#lfEmail'), errEl = form.querySelector('#lfError');
    var subBtn = form.querySelector('#lfSubmit');
    setTimeout(function(){ try { nEl.focus(); } catch(_){} }, 100);
    function showErr(m) { errEl.textContent = m; errEl.style.display = 'block'; }
    function sub() {
      errEl.style.display = 'none';
      var name = (nEl.value||'').trim(), phone = (pEl.value||'').trim(), email = (eEl.value||'').trim();
      if (!name) { showErr('Please enter your name.'); return; }
      if (!phone && !email) { showErr('Please enter a phone number or email.'); return; }
      subBtn.disabled = true; subBtn.textContent = '...';
      fetch(API + '/api/chatbot-public/capture-lead', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ chatbotId: CID, name: name, phone: phone, email: email })
      })
      .then(function(r) { if (!r.ok) throw new Error('failed'); return r.json(); })
      .then(function(d) {
        markLeadCaptured();
        form.style.opacity = '0.5'; leadFormVisible = false;
        ci.disabled = false; sb.disabled = !ci.value.trim();
        addBotMsg(d && d.deduped ? 'Thank you — I found your existing details. How else can I help you?' : 'Thank you! How else can I help you?');
      })
      .catch(function() { subBtn.disabled = false; subBtn.textContent = 'Save details'; showErr('Could not save details. Please try again.'); });
    }
    subBtn.onclick = sub;
    [nEl, pEl, eEl].forEach(function(el){ el.addEventListener('keydown', function(e){ if(e.key==='Enter'){e.preventDefault();sub();} }); });
  }

  /* =========================================================
   * VOICE CONVERSATION MODE — OpenAI Realtime API
   * System prompt is built browser-side from injected config.
   * Railway proxy gets it in session.init — no Supabase needed.
   * ========================================================= */
  var vmActive = false, vmWs = null, vmMicStream = null;
  var vmAudioCtx = null, vmScriptProc = null;
  var vmPlaybackNode = null, vmPlayQueue = [], vmPlaying = false;
  var vmOrb = document.getElementById('vmOrb');
  var vmStatus = document.getElementById('vmStatus');
  var vmHint = document.getElementById('vmHint');
  var vmLangEl = document.getElementById('vmLang');
  var vMode = document.getElementById('vMode');
  var vmBtn2 = document.getElementById('vmBtn');
  var vmEnd2 = document.getElementById('vmEnd');

  function vmPhase(p, s, h) {
    if (vmOrb) { vmOrb.classList.remove('listening','speaking','thinking'); if (p !== 'idle') vmOrb.classList.add(p); }
    if (vmStatus && s != null) vmStatus.textContent = s;
    if (vmHint   && h != null) vmHint.textContent   = h;
  }

  function vmPrompt() {
    var parts = [];
    if (VOICE_SYSTEM_PROMPT && VOICE_SYSTEM_PROMPT.trim()) {
      parts.push(VOICE_SYSTEM_PROMPT);
    } else {
      parts.push('You are ' + AGENT_NAME + ', the website receptionist for this business. Stay focused on the business, its website, services, products, pages, links, FAQs, and support. Never introduce yourself as OpenAI or as a generic AI module. If you do not know an answer from the provided business context, say so and offer to take a message.');
    }
    parts.push('Voice mode: keep every reply to 1-3 short natural sentences. Do not use markdown or bullet points while speaking.');
    if (LANGUAGES && LANGUAGES.length > 0) {
      var ln = LANGUAGES.map(function(l){ return LANG_NAMES[l] || l.toUpperCase(); });
      parts.push('Respond ONLY in: ' + ln.join(' or ') + '. Never switch languages.');
    }
    if (COLLECT_LEADS) {
      parts.push('Ask for name and either phone or email only when follow-up is needed. Do not ask repeatedly once the visitor has already provided it.');
    }
    return parts.join('\n\n').slice(0, 12000);
  }

  if (vmBtn2) vmBtn2.onclick = function() { if (vmActive) stopVM(); else { if (COLLECT_LEADS && !leadAlreadyCaptured()) { renderLeadForm(); return; } void startVM(); } };
  if (vmEnd2) vmEnd2.onclick = function() { stopVM(); };

  async function startVM() {
    if (vmActive) return;
    if (!REALTIME_WS_BASE) { addBotMsg('Voice mode is not configured.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addBotMsg('Your browser does not support microphone access. Please use Chrome or Firefox.');
      return;
    }
    vmActive = true;
    if (vMode) vMode.classList.add('on');
    if (vmLangEl) vmLangEl.textContent = (currentLang || 'en').toUpperCase();
    vmPhase('idle', 'Connecting...', '');

    var mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      vmActive = false;
      if (vMode) vMode.classList.remove('on');
      addBotMsg('Microphone access denied. Please allow microphone access and try again.');
      return;
    }
    vmMicStream = mic;

    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      vmAudioCtx = new AC();
      if (vmAudioCtx.state === 'suspended') vmAudioCtx.resume();
    } catch (e) {
      vmActive = false;
      cleanVM();
      if (vMode) vMode.classList.remove('on');
      addBotMsg('Voice mode is not supported by your browser.');
      return;
    }

    try {
      vmWs = new WebSocket(REALTIME_WS_BASE + '/realtime?chatbotId=' + encodeURIComponent(CID));
      vmWs.binaryType = 'arraybuffer';
    } catch (e) {
      vmActive = false;
      cleanVM();
      if (vMode) vMode.classList.remove('on');
      addBotMsg('Could not connect to voice service. Please try again.');
      return;
    }

    vmWs.onopen = function() {
      try {
        vmWs.send(JSON.stringify({ type: 'session.init', chatbotId: CID, systemPrompt: vmPrompt(), voice: CHAT_VOICE || 'alloy' }));
      } catch(e) { console.error('[vm] init send failed:', e.message); }
      vmPhase('thinking', 'Connecting to AI...', '');
    };

    vmWs.onmessage = function(event) {
      if (!vmActive) return;
      if (event.data instanceof ArrayBuffer) { playPCM(event.data); return; }
      var msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'session.connecting') { vmPhase('thinking', 'Connecting to AI...', ''); }
      else if (msg.type === 'session.ready') {
        micStream(mic, vmAudioCtx);
        vmPhase('listening', 'Listening... speak now', 'I will reply instantly when you pause.');
      }
      else if (msg.type === 'input_audio_buffer.speech_started') { stopPCM(); vmPhase('listening', 'Listening...', ''); }
      else if (msg.type === 'input_audio_buffer.speech_stopped' || msg.type === 'input_audio_buffer.committed') { vmPhase('thinking', 'Thinking...', ''); }
      else if ((msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') && msg.delta) {
        // OpenAI Realtime audio arrives as base64 PCM16 JSON deltas on the proxy path.
        // Keep binary frame support too, so the previous working milestone remains safe.
        var audioAb = b64ToArrayBuffer(msg.delta);
        if (audioAb && audioAb.byteLength) playPCM(audioAb);
        vmPhase('speaking', 'Speaking...', 'Tap end to stop.');
      }
      else if (msg.type === 'response.created') { vmPhase('speaking', 'Speaking...', 'Tap end to stop.'); }
      else if (msg.type === 'response.done' || msg.type === 'response.audio.done') {
        var waitT = setInterval(function() { if (!vmPlaying && !vmPlayQueue.length) { clearInterval(waitT); if (vmActive) vmPhase('listening', 'Listening...', 'I will reply instantly when you pause.'); } }, 80);
      }
      else if (msg.type === 'conversation.item.input_audio_transcription.completed') { var t=(msg.transcript||'').trim(); if(t) addUserMsg(t); }
      else if (msg.type === 'response.audio_transcript.done') { var at=(msg.transcript||'').trim(); if(at) addBotMsg(at); }
      else if (msg.type === 'error') { 
        console.error('[vm] error:', msg.error || msg.message); 
        var errMsg = msg.message || (msg.error && msg.error.message) || 'Voice mode encountered an error';
        stopVM();
        addBotMsg('Sorry, ' + errMsg + '. Please try text chat instead.');
      }
    };

    vmWs.onerror = function(e) { console.error('[vm] ws error:', e); };
    vmWs.onclose = function(ev) {
      console.log('[vm] closed code=' + ev.code + ' reason=' + ev.reason);
      if (!vmActive) return;
      vmActive = false;
      stopPCM(); cleanVM();
      if (vMode) vMode.classList.remove('on');
      if (ev.code !== 1000) addBotMsg('Voice connection lost. Please try again.');
    };
  }

  function stopVM() {
    if (!vmActive && !(vMode && vMode.classList.contains('on'))) return;
    vmActive = false;
    stopPCM(); cleanVM();
    if (vmWs) { try { vmWs.send(JSON.stringify({type:'session.end'})); } catch(_){} try { vmWs.close(1000); } catch(_){} vmWs = null; }
    vmPhase('idle', '', '');
    if (vMode) vMode.classList.remove('on');
  }

  function micStream(stream, actx) {
    if (!actx || actx.state === 'closed') return;
    var srcRate = actx.sampleRate;

    function sendF32(f32) {
      if (!vmActive || !vmWs || vmWs.readyState !== 1) return;
      var n = srcRate === 24000 ? f32.length : Math.round(f32.length * 24000 / srcRate);
      var o = new Float32Array(n);
      for (var i = 0; i < n; i++) o[i] = f32[Math.min(Math.round(i * srcRate / 24000), f32.length - 1)];
      var s = new Int16Array(n);
      for (var j = 0; j < n; j++) { var v = Math.max(-1, Math.min(1, o[j])); s[j] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
      var b = new Uint8Array(s.buffer), bin = '';
      for (var k = 0; k < b.length; k++) bin += String.fromCharCode(b[k]);
      try { vmWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) })); } catch (_) {}
    }

    var src = actx.createMediaStreamSource(stream);

    // Try AudioWorklet (no deprecation warning)
    if (actx.audioWorklet && actx.audioWorklet.addModule) {
      // Worklet code as data URL — avoids backtick issues and no external file needed
      var code = 'class P extends AudioWorkletProcessor{constructor(){super();this._b=[];}process(i){var c=i[0][0];if(c)for(var j=0;j<c.length;j++)this._b.push(c[j]);if(this._b.length>=4096)this.port.postMessage(new Float32Array(this._b.splice(0,4096)));return true;}}registerProcessor("agently-p",P);';
      var blob = new Blob([code], { type: 'application/javascript' });
      var url  = URL.createObjectURL(blob);
      actx.audioWorklet.addModule(url).then(function() {
        URL.revokeObjectURL(url);
        var node = new AudioWorkletNode(actx, 'agently-p');
        node.port.onmessage = function(e) { sendF32(e.data); };
        src.connect(node);
        node.connect(actx.destination);
        vmScriptProc = node;
      }).catch(function() {
        // AudioWorklet failed (sandbox CSP blocks blob: URLs) — fall back
        legacyProc(src, actx, sendF32);
      });
    } else {
      legacyProc(src, actx, sendF32);
    }
  }

  function legacyProc(src, actx, sendF32) {
    var proc = actx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = function(e) { sendF32(e.inputBuffer.getChannelData(0)); };
    src.connect(proc);
    proc.connect(actx.destination);
    vmScriptProc = proc;
  }

  function b64ToArrayBuffer(b64) {
    try {
      var bin = atob(String(b64 || ''));
      var len = bin.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    } catch (_) { return null; }
  }

  function playPCM(ab) {
    if (!vmAudioCtx || vmAudioCtx.state === 'closed' || !ab || !ab.byteLength) return;
    var i16 = new Int16Array(ab), f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7FFF);
    var buf = vmAudioCtx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    vmPlayQueue.push(buf);
    if (!vmPlaying) drainPCM();
  }

  function drainPCM() {
    if (!vmActive || !vmAudioCtx || vmAudioCtx.state === 'closed' || !vmPlayQueue.length) { vmPlaying = false; return; }
    vmPlaying = true;
    var buf = vmPlayQueue.shift();
    var src = vmAudioCtx.createBufferSource();
    src.buffer = buf; src.connect(vmAudioCtx.destination);
    src.onended = function() { drainPCM(); };
    src.start(); vmPlaybackNode = src;
  }

  function stopPCM() {
    vmPlayQueue = []; vmPlaying = false;
    if (vmPlaybackNode) { try { vmPlaybackNode.stop(); } catch(_){} vmPlaybackNode = null; }
  }

  function cleanVM() {
    if (vmScriptProc) { try { vmScriptProc.disconnect(); } catch(_){} vmScriptProc = null; }
    if (vmMicStream) { try { vmMicStream.getTracks().forEach(function(t){t.stop();}); } catch(_){} vmMicStream = null; }
    if (vmAudioCtx) { try { vmAudioCtx.close(); } catch(_){} vmAudioCtx = null; }
  }




  /* ── Speaker toggle + Mic recording + TTS (text-mode voice features) ── */
  var speakMode = false;
  var recording = false;
  var mediaRecorder = null;
  var audioChunks = [];
  var mediaStream = null;
  var recStart = 0;
  var recTimer = null;
  var currentAudio = null;
  var spk = document.getElementById('spk');
  var icoSpkOff = document.getElementById('ico-spk-off');
  var icoSpkOn  = document.getElementById('ico-spk-on');
  var mic = document.getElementById('mic');
  var recBar = document.getElementById('recBar');
  var recTime = document.getElementById('recTime');
  var hasMediaRecorder = typeof window.MediaRecorder !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  if (!hasMediaRecorder && mic) mic.style.display = 'none';

  if (spk) {
    spk.onclick = function() {
      speakMode = !speakMode;
      spk.classList.toggle('on', speakMode);
      spk.title = speakMode ? 'Voice replies on' : 'Voice replies off';
      if (icoSpkOff) icoSpkOff.style.display = speakMode ? 'none' : '';
      if (icoSpkOn)  icoSpkOn.style.display  = speakMode ? '' : 'none';
      if (!speakMode) stopTTSPlayback();
    };
  }

  function stopTTSPlayback() {
    if (currentAudio) { try { currentAudio.pause(); } catch(_){} currentAudio = null; }
    if (spk) spk.classList.remove('playing');
  }

  function pickMimeType() {
    var c = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg'];
    for (var i = 0; i < c.length; i++) { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i]; }
    return '';
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms/1000), m = Math.floor(s/60); s = s%60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function setRecUI(on) {
    recording = on;
    if (mic) mic.classList.toggle('recording', on);
    if (ci)  ci.style.display = on ? 'none' : '';
    if (recBar) recBar.classList.toggle('on', on);
    if (on) {
      recStart = Date.now();
      if (recTime) recTime.textContent = '0:00';
      recTimer = setInterval(function() { if (recTime) recTime.textContent = fmtDuration(Date.now()-recStart); }, 250);
    } else {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
    }
  }

  if (mic) {
    mic.onclick = function() {
      if (recording) { stopRecording(); return; }
      startRecording();
    };
  }

  function startRecording() {
    if (!hasMediaRecorder) return;
    stopTTSPlayback();
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        mediaStream = stream;
        audioChunks = [];
        var mimeType = pickMimeType();
        try { mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream); }
        catch(err) { console.error('MediaRecorder init failed', err); cleanupStream(); return; }
        mediaRecorder.ondataavailable = function(e) { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = function() {
          setRecUI(false);
          var blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
          cleanupStream();
          if (blob.size < 500) return;
          void transcribeAndFill(blob);
        };
        mediaRecorder.start();
        setRecUI(true);
      })
      .catch(function(err) {
        console.error('Mic denied', err);
        addBotMsg('I need microphone access to record. Please allow access and try again.');
      });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch(_){} }
    else { setRecUI(false); cleanupStream(); }
  }

  function cleanupStream() {
    if (mediaStream) { try { mediaStream.getTracks().forEach(function(t){t.stop();}); } catch(_){} mediaStream = null; }
  }

  function transcribeAndFill(blob) {
    if (ci) { ci.disabled = true; ci.placeholder = 'Transcribing...'; }
    if (sb) sb.disabled = true;
    if (mic) mic.disabled = true;
    return fetch(API + '/api/chatbot-public/transcribe?chatbotId=' + encodeURIComponent(CID), {
      method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob,
    })
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('Transcription failed')); })
    .then(function(data) {
      if (ci) ci.value = (data && data.text) || '';
      if (ci && ci.value.trim()) {
        ci.style.height = 'auto';
        ci.style.height = Math.min(ci.scrollHeight, 100) + 'px';
        sendMessage();
      }
    })
    .catch(function(err) {
      console.error('Transcribe error', err);
      addBotMsg("I couldn't transcribe that audio. Please try again.");
    })
    .finally(function() {
      if (ci) { ci.disabled = false; ci.placeholder = PLACEHOLDER; }
      if (mic) mic.disabled = false;
      if (sb) sb.disabled = !(ci && ci.value.trim());
    });
  }

  function speakReply(text) {
    if (!speakMode || !text) return;
    stopTTSPlayback();
    fetch(API + '/api/chatbot-public/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, chatbotId: CID }),
    })
    .then(function(r) { return r.ok ? r.blob() : null; })
    .then(function(blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      if (spk) spk.classList.add('playing');
      currentAudio.onended = function() { if (spk) spk.classList.remove('playing'); URL.revokeObjectURL(url); currentAudio = null; };
      currentAudio.onerror = function() { if (spk) spk.classList.remove('playing'); currentAudio = null; };
      currentAudio.play().catch(function(err) {
        console.warn('Audio play blocked:', err && err.message ? err.message : err);
        if (spk) spk.classList.remove('playing');
      });
    })
    .catch(function(err) { console.warn('TTS failed:', err && err.message ? err.message : err); });
  }

  /* ── Lead Capture ──────────────────────────────────────────── */
  var leadFormVisible = false;
  var leadAttempts = 0;
  var MAX_LEAD_ATTEMPTS = 3;

  function leadAlreadyCaptured() {
    try { return sessionStorage.getItem(LEAD_CAPTURED_KEY) === 'true' || localStorage.getItem(LEAD_CAPTURED_KEY) === 'true'; } catch(_) { return false; }
  }
  function markLeadCaptured() {
    try { sessionStorage.setItem(LEAD_CAPTURED_KEY, 'true'); localStorage.setItem(LEAD_CAPTURED_KEY, 'true'); } catch(_) {}
  }

  function maybeTriggerLeadCapture() {
    if (!COLLECT_LEADS || leadAlreadyCaptured() || leadFormVisible || vmActive) return;
    if (leadAttempts >= MAX_LEAD_ATTEMPTS) return;
    var userMsgs = history.filter(function(m){ return m.role === 'user'; }).length;
    var botMsgs  = history.filter(function(m){ return m.role === 'model'; }).length;
    if (userMsgs < 1 || botMsgs < 2) return;
    leadAttempts++;
    setTimeout(function() { addBotMsg('To serve you better, may I get your name and contact details (phone or email)?'); renderLeadForm(); }, 600);
  }

  function renderLeadForm() {
    if (leadFormVisible || leadAlreadyCaptured()) return;
    leadFormVisible = true;
    ci.disabled = true; sb.disabled = true;
    var form = document.createElement('div');
    form.className = 'leadForm'; form.id = 'leadForm';
    form.innerHTML = '<div class="lfTitle">Quick details</div>'
      + '<div class="lfHint">Name and one of email or phone is required.</div>'
      + '<div class="lfField"><label class="lfLabel">Name *</label><input class="lfInput" id="lfName" type="text" autocomplete="name"/></div>'
      + '<div class="lfRow"><div class="lfField"><label class="lfLabel">Phone</label><input class="lfInput" id="lfPhone" type="tel"/></div>'
      + '<div class="lfField"><label class="lfLabel">Email</label><input class="lfInput" id="lfEmail" type="email"/></div></div>'
      + '<div class="lfError" id="lfError"></div>'
      + '<div class="lfActions"><button class="lfSubmit" type="button" id="lfSubmit">Save details</button></div>';
    msgs.appendChild(form); msgs.scrollTop = msgs.scrollHeight;
    var nEl = form.querySelector('#lfName'), pEl = form.querySelector('#lfPhone');
    var eEl = form.querySelector('#lfEmail'), errEl = form.querySelector('#lfError');
    var subBtn = form.querySelector('#lfSubmit');
    setTimeout(function(){ try { nEl.focus(); } catch(_){} }, 100);
    function showErr(m) { errEl.textContent = m; errEl.style.display = 'block'; }
    function sub() {
      errEl.style.display = 'none';
      var name = (nEl.value||'').trim(), phone = (pEl.value||'').trim(), email = (eEl.value||'').trim();
      if (!name) { showErr('Please enter your name.'); return; }
      if (!phone && !email) { showErr('Please enter a phone number or email.'); return; }
      subBtn.disabled = true; subBtn.textContent = '...';
      fetch(API + '/api/chatbot-public/capture-lead', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ chatbotId: CID, name: name, phone: phone, email: email })
      })
      .then(function(r) { if (!r.ok) throw new Error('failed'); return r.json(); })
      .then(function(d) {
        markLeadCaptured();
        form.style.opacity = '0.5'; leadFormVisible = false;
        ci.disabled = false; sb.disabled = !ci.value.trim();
        addBotMsg(d && d.deduped ? 'Thank you — I found your existing details. How else can I help you?' : 'Thank you! How else can I help you?');
      })
      .catch(function() { subBtn.disabled = false; subBtn.textContent = 'Save details'; showErr('Could not save details. Please try again.'); });
    }
    subBtn.onclick = sub;
    [nEl, pEl, eEl].forEach(function(el){ el.addEventListener('keydown', function(e){ if(e.key==='Enter'){e.preventDefault();sub();} }); });
  }

  /* ========================================================= */
})();
</script>
</body>
</html>`;
}

module.exports = router;
