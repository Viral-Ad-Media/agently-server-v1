"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
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
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https:;",
    );
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(buildWidgetHtml(cfg));
  }),
);

function safeStr(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, "\\n")
    .replace(/<\/script>/gi, "<\\/script>");
}

function buildWidgetHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${cfg.headerTitle.replace(/\\'/g, "'").replace(/\\n/g, "")}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
:root{--a:${cfg.accentColor};--ad:${cfg.accentColor}cc;--al:${cfg.accentColor}18}
#launcher{position:fixed;bottom:20px;${cfg.position}:20px;width:56px;height:56px;background:var(--a);border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.22);color:#fff;z-index:2147483646;transition:transform .2s,box-shadow .2s;}
#launcher:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,.28)}
#launcher svg{pointer-events:none}
#cw{position:fixed;bottom:88px;${cfg.position}:16px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 104px);background:#fff;border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;transform-origin:bottom ${cfg.position};transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;}
#cw.hide{transform:scale(.85) translateY(12px);opacity:0;pointer-events:none}
.hdr{background:var(--a);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px;flex-shrink:0;}
.av{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0;letter-spacing:-.02em;}
.ht{flex:1;min-width:0}.hn{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hs{font-size:11px;opacity:.82;margin-top:1px;display:flex;align-items:center;gap:5px}
.dot{width:7px;height:7px;background:#4ade80;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.xb{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.8;transition:opacity .2s,background .2s;margin-left:4px}
.xb:hover{opacity:1;background:rgba(255,255,255,.15)}
#msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;scroll-behavior:smooth;}
#msgs::-webkit-scrollbar{width:4px}
#msgs::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}
.bubble{max-width:84%;display:flex;flex-direction:column}
.bubble.bot{align-self:flex-start}
.bubble.usr{align-self:flex-end;align-items:flex-end}
.btext{padding:10px 14px;border-radius:18px;font-size:13.5px;line-height:1.55;word-break:break-word;}
.bot .btext{background:#fff;border:1px solid #e8edf2;border-bottom-left-radius:4px;color:#1e293b;}
.usr .btext{background:var(--a);color:#fff;border-bottom-right-radius:4px;}
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
</style>
</head>
<body>
<div id="cw" class="hide" role="dialog" aria-label="Chat window">
  <div class="hdr">
    <div class="av" aria-hidden="true">${cfg.avatarLabel.replace(/\\'/g, "'")}</div>
    <div class="ht">
      <div class="hn">${cfg.headerTitle.replace(/\\'/g, "'").replace(/\\n/g, "")}</div>
      <div class="hs"><span class="dot"></span>Online · Instant replies</div>
    </div>
    <button class="xb" id="xb" aria-label="Close chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
  </div>
  <div id="msgs" role="log" aria-live="polite" aria-label="Chat messages"></div>
  <div id="chips" role="list" aria-label="Suggested questions"></div>
  <div class="ir">
    <textarea id="ci" placeholder="${cfg.placeholder.replace(/\\'/g, "'")}" rows="1" aria-label="Message input"></textarea>
    <button id="sb" aria-label="Send message" disabled><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
  </div>
  <div class="pw">Powered by <a href="https://agently.ai" target="_blank" rel="noopener">Agently</a></div>
</div>
<button id="launcher" aria-label="Open chat" aria-expanded="false">
  <svg id="ico-chat" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <svg id="ico-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:none"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
</button>
<script>
(function() {
  'use strict';
  console.log('Widget script loaded');
  var CID = '${cfg.chatbotId}';
  var API = '${cfg.apiUrl}';
  var WELCOME = '${cfg.welcomeMessage}';
  var FAQS = ${cfg.faqs};
  var PROMPTS = ${cfg.suggestedPrompts};

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

  if (!cw || !launcher) {
    console.error('Critical elements missing');
    return;
  }

  PROMPTS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = p;
    btn.onclick = function() { sendMessage(p); };
    chips.appendChild(btn);
  });

  var sessionLoaded = false;

  function toggle() {
    console.log('toggle called, isOpen:', isOpen);
    isOpen = !isOpen;
    cw.classList.toggle('hide', !isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    icoChat.style.display = isOpen ? 'none' : '';
    icoClose.style.display = isOpen ? '' : 'none';
    if (isOpen && !sessionLoaded) {
      sessionLoaded = true;
      loadSession();
    }
    if (isOpen && !greeted) {
      greeted = true;
      setTimeout(function() { addBotMsg(WELCOME); }, 200);
    }
    if (isOpen) { setTimeout(function() { ci.focus(); }, 250); }
  }

  launcher.onclick = toggle;
  xb.onclick = toggle;

  ci.oninput = function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    sb.disabled = !this.value.trim();
  };
  ci.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sb.disabled) sendMessage();
    }
  };
  sb.onclick = function() { sendMessage(); };

  function ft() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderMd(text) {
    var s = String(text || '');
    s = s.replace(/\\n/g, '\n').replace(/\\t/g, ' ');
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">$1</a>');
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">$2</a>');
    s = s.replace(/(^|\n)[\*\-•] (.+)/g, '$1<li>$2</li>');
    if (s.includes('<li>')) s = s.replace(/(<li>.*<\/li>)/gs, '<ul style="margin:6px 0 6px 16px;padding:0">$1</ul>');
    s = s.replace(/(^|\n)\d+\. (.+)/g, '$1<li>$2</li>');
    s = s.replace(/\n/g, '<br>');
    return s;
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
          if (m.role === 'model') {
            history.push({ role: 'model', text: m.text });
            addMsg('bot', m.text, true);
          } else {
            history.push({ role: 'user', text: m.text });
            addMsg('usr', m.text, true);
          }
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

  function addBotMsg(text) {
    history.push({ role: 'model', text: text });
    return addMsg('bot', text);
  }
  function addUserMsg(text) {
    history.push({ role: 'user', text: text });
    return addMsg('usr', text);
  }

  function showTyping() {
    var wrap = document.createElement('div');
    wrap.id = 'typ';
    wrap.className = 'bubble bot typing';
    var inner = document.createElement('div');
    inner.className = 'btext';
    inner.innerHTML = '<div class="tdots"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
    wrap.appendChild(inner);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping() {
    var t = document.getElementById('typ');
    if (t) t.remove();
  }

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
      setTimeout(function() {
        hideTyping();
        addBotMsg(local);
        sending = false;
        ci.focus();
      }, 500);
      return;
    }
    fetch(API + '/api/chatbot-public/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        chatbotId: CID,
        history: history.slice(-12)
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      hideTyping();
      var reply = d.response || d.error?.message || "I'm here to help! Could you rephrase that?";
      addBotMsg(reply);
    })
    .catch(function() {
      hideTyping();
      addBotMsg("Sorry, I'm having trouble connecting right now. Please try again in a moment.");
    })
    .finally(function() {
      sending = false;
      ci.focus();
    });
  }
})();
</script>
</body>
</html>`;
}

module.exports = router;
