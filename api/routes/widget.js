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
    const config = {
      chatbotId: id,
      apiUrl,
      accentColor: chatbot.accent_color || "#4f46e5",
      headerTitle: chatbot.header_title || "Chat with us",
      welcomeMessage:
        chatbot.welcome_message || "Hello! How can I help you today?",
      placeholder: chatbot.placeholder || "Type your message...",
      avatarLabel: chatbot.avatar_label || "A",
      launcherLabel: chatbot.launcher_label || "Chat",
      position: chatbot.position === "left" ? "left" : "right",
      suggestedPrompts: Array.isArray(chatbot.suggested_prompts)
        ? chatbot.suggested_prompts
        : [],
      faqs: Array.isArray(chatbot.faqs) ? chatbot.faqs : [],
      collectLeads: chatbot.collect_leads !== false,
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors *; default-src 'self' 'unsafe-inline' https:;",
    );
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(buildWidgetHtml(config));
  }),
);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function buildWidgetHtml(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escapeHtml(config.headerTitle)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
:root{--a:${escapeHtml(config.accentColor)};--al:${escapeHtml(config.accentColor)}18}
#launcher{position:fixed;bottom:20px;${config.position}:20px;display:flex;align-items:center;justify-content:center;gap:8px;min-width:56px;height:56px;padding:0 18px;background:var(--a);border-radius:999px;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.22);color:#fff;z-index:2147483646;transition:transform .2s,box-shadow .2s;font:700 13px/1.1 inherit}
#launcher:hover{transform:scale(1.04);box-shadow:0 8px 28px rgba(0,0,0,.26)}
#launcher svg{pointer-events:none;flex-shrink:0}
#launcher-label{display:none}
#cw{position:fixed;bottom:88px;${config.position}:16px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 104px);background:#fff;border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;transform-origin:bottom ${config.position};transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s,visibility .2s}
#cw.hide{transform:scale(.88) translateY(14px);opacity:0;pointer-events:none;visibility:hidden}
.hdr{background:var(--a);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:11px;flex-shrink:0}
.av{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0;letter-spacing:-.02em}
.ht{flex:1;min-width:0}.hn{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hs{font-size:11px;opacity:.82;margin-top:1px;display:flex;align-items:center;gap:5px}.dot{width:7px;height:7px;background:#4ade80;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.xb{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:.8;transition:opacity .2s,background .2s;margin-left:4px}.xb:hover{opacity:1;background:rgba(255,255,255,.15)}
#msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;scroll-behavior:smooth}#msgs::-webkit-scrollbar{width:4px}#msgs::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}
.bubble{max-width:84%;display:flex;flex-direction:column}.bubble.bot{align-self:flex-start}.bubble.usr{align-self:flex-end;align-items:flex-end}.btext{padding:10px 14px;border-radius:18px;font-size:13.5px;line-height:1.55;word-break:break-word}.bot .btext{background:#fff;border:1px solid #e8edf2;border-bottom-left-radius:4px;color:#1e293b}.usr .btext{background:var(--a);color:#fff;border-bottom-right-radius:4px}.btime{font-size:10px;color:#94a3b8;margin-top:3px;padding:0 4px}
.typing .btext{padding:12px 16px}.tdots{display:flex;gap:4px;align-items:center}.td{width:7px;height:7px;background:#94a3b8;border-radius:50%;animation:bop 1.3s infinite}.td:nth-child(2){animation-delay:.2s}.td:nth-child(3){animation-delay:.4s}@keyframes bop{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
#chips{display:flex;gap:7px;padding:8px 14px;overflow-x:auto;flex-shrink:0;background:#f8fafc;border-top:1px solid #eef2f7}#chips:empty{display:none}#chips::-webkit-scrollbar{display:none}.chip{white-space:nowrap;background:#fff;border:1.5px solid #e2e8f0;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;color:#374151;transition:border-color .15s,color .15s,background .15s;flex-shrink:0}.chip:hover{border-color:var(--a);color:var(--a);background:var(--al)}
#leadgate{padding:12px 14px;border-top:1px solid #eef2f7;background:#fff;display:none;flex-direction:column;gap:8px}#leadgate.show{display:flex}.lg-title{font-size:12.5px;font-weight:700;color:#111827}.lg-copy{font-size:11.5px;color:#64748b;line-height:1.5}.lg-row{display:flex;gap:8px}.lg-input{width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:13px;outline:none}.lg-input:focus{border-color:var(--a)}#lead-submit{background:var(--a);color:#fff;border:none;border-radius:12px;padding:10px 12px;font-size:12.5px;font-weight:700;cursor:pointer}#lead-skip{background:#fff;color:#475569;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font-size:12.5px;font-weight:600;cursor:pointer}#lead-error{font-size:11.5px;color:#dc2626;display:none}
.ir{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eef2f7;background:#fff;flex-shrink:0;align-items:flex-end}#ci{flex:1;padding:10px 13px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:13.5px;outline:none;resize:none;min-height:42px;max-height:100px;transition:border-color .2s;font-family:inherit;line-height:1.4;overflow-y:auto}#ci:focus{border-color:var(--a)}#sb{background:var(--a);color:#fff;border:none;border-radius:12px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:opacity .2s,transform .15s}#sb:hover{opacity:.88;transform:scale(1.04)}#sb:active{transform:scale(.96)}#sb:disabled{opacity:.45;cursor:not-allowed;transform:none}
.pw{text-align:center;font-size:10.5px;color:#94a3b8;padding:5px 14px 7px;background:#fff;border-top:1px solid #f1f5f9;flex-shrink:0;letter-spacing:.01em}.pw a{color:var(--a);text-decoration:none;font-weight:600}.pw a:hover{text-decoration:underline}
@media (min-width: 640px){#launcher-label{display:inline}}
</style>
</head>
<body>
<div id="cw" class="hide" role="dialog" aria-label="Chat window">
  <div class="hdr">
    <div class="av" id="avatar-label" aria-hidden="true">A</div>
    <div class="ht">
      <div class="hn" id="header-title">Chat with us</div>
      <div class="hs"><span class="dot"></span>Online · Instant replies</div>
    </div>
    <button class="xb" id="xb" aria-label="Close chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
  </div>
  <div id="msgs" role="log" aria-live="polite" aria-label="Chat messages"></div>
  <div id="chips" role="list" aria-label="Suggested questions"></div>
  <div id="leadgate">
    <div class="lg-title">Before we continue</div>
    <div class="lg-copy">Please share your details so the team can follow up if needed.</div>
    <div class="lg-row"><input id="lead-name" class="lg-input" placeholder="Your name" /><input id="lead-email" class="lg-input" placeholder="Email address" /></div>
    <div class="lg-row"><input id="lead-phone" class="lg-input" placeholder="Phone number" /></div>
    <div id="lead-error"></div>
    <div class="lg-row"><button id="lead-submit" type="button">Continue</button></div>
  </div>
  <div class="ir">
    <textarea id="ci" rows="1" aria-label="Message input"></textarea>
    <button id="sb" aria-label="Send message" disabled><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
  </div>
  <div class="pw">Powered by <a href="https://agently.ai" target="_blank" rel="noopener">Agently</a></div>
</div>
<button id="launcher" aria-label="Open chat" aria-expanded="false">
  <svg id="ico-chat" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <svg id="ico-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:none"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
  <span id="launcher-label"></span>
</button>
<script id="agently-config" type="application/json">${safeJson(config)}</script>
<script>
(function() {
  'use strict';

  function renderMd(text) {
    var output = String(text || '');
    output = output.replace(/\\n/g, '\n').replace(/\\t/g, ' ');
    output = output.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    output = output.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    output = output.replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>');
    output = output.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
    output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">$1</a>');
    output = output.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">$2</a>');
    output = output.replace(/(^|\n)[\*\-•] (.+)/g, '$1<li>$2</li>');
    if (output.indexOf('<li>') !== -1) {
      output = output.replace(/(<li>.*<\/li>)/gs, '<ul style="margin:6px 0 6px 16px;padding:0">$1</ul>');
    }
    output = output.replace(/(^|\n)\d+\. (.+)/g, '$1<li>$2</li>');
    return output.replace(/\n/g, '<br>');
  }

  function escapeUserText(text) {
    return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function timeLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  var rawConfig = document.getElementById('agently-config');
  if (!rawConfig) return;

  var config;
  try {
    config = JSON.parse(rawConfig.textContent || '{}');
  } catch (err) {
    console.error('Failed to parse widget config:', err);
    return;
  }

  var cw = document.getElementById('cw');
  var launcher = document.getElementById('launcher');
  var xb = document.getElementById('xb');
  var msgs = document.getElementById('msgs');
  var chips = document.getElementById('chips');
  var ci = document.getElementById('ci');
  var sb = document.getElementById('sb');
  var leadGate = document.getElementById('leadgate');
  var leadName = document.getElementById('lead-name');
  var leadEmail = document.getElementById('lead-email');
  var leadPhone = document.getElementById('lead-phone');
  var leadSubmit = document.getElementById('lead-submit');
  var leadError = document.getElementById('lead-error');
  var icoChat = document.getElementById('ico-chat');
  var icoClose = document.getElementById('ico-close');
  var avatarLabel = document.getElementById('avatar-label');
  var headerTitle = document.getElementById('header-title');
  var launcherLabel = document.getElementById('launcher-label');

  if (!cw || !launcher || !xb || !msgs || !chips || !ci || !sb) {
    console.error('Widget UI failed to initialize');
    return;
  }

  avatarLabel.textContent = config.avatarLabel || 'A';
  headerTitle.textContent = config.headerTitle || 'Chat with us';
  launcherLabel.textContent = config.launcherLabel || 'Chat';
  ci.setAttribute('placeholder', config.placeholder || 'Type your message...');

  var isOpen = false;
  var greeted = false;
  var sending = false;
  var sessionLoaded = false;
  var leadCaptured = false;
  var history = [];
  var suggestedPrompts = Array.isArray(config.suggestedPrompts) ? config.suggestedPrompts : [];
  var faqs = Array.isArray(config.faqs) ? config.faqs : [];
  var collectLeads = config.collectLeads !== false;
  var sessionKey = 'agently_chat_' + config.chatbotId;
  var leadKey = sessionKey + '_lead';

  function saveSession() {
    try { sessionStorage.setItem(sessionKey, JSON.stringify(history.slice(-40))); } catch (err) {}
  }

  function addMsg(role, text, skipSave) {
    var wrap = document.createElement('div');
    wrap.className = 'bubble ' + (role === 'bot' ? 'bot' : 'usr');

    var inner = document.createElement('div');
    inner.className = 'btext';
    inner.innerHTML = role === 'bot' ? renderMd(text) : escapeUserText(text);

    var time = document.createElement('div');
    time.className = 'btime';
    time.textContent = timeLabel();

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
    var typing = document.getElementById('typ');
    if (typing) typing.remove();
  }

  function localAnswer(question) {
    var lowered = String(question || '').toLowerCase();
    for (var index = 0; index < faqs.length; index += 1) {
      var faq = faqs[index] || {};
      if (!faq.question) continue;
      var keywords = String(faq.question).toLowerCase().split(/\s+/).filter(function(word) {
        return word.length > 4;
      });
      var hits = keywords.filter(function(keyword) { return lowered.indexOf(keyword) !== -1; });
      if (keywords.length > 0 && hits.length >= Math.min(2, keywords.length)) {
        return faq.answer || null;
      }
    }
    return null;
  }


  function loadLeadState() {
    try {
      var savedLead = JSON.parse(sessionStorage.getItem(leadKey) || 'null');
      if (savedLead && (savedLead.email || savedLead.phone) && savedLead.name) {
        leadCaptured = true;
      }
    } catch (err) {}
  }

  function setLeadError(message) {
    if (!leadError) return;
    leadError.style.display = message ? 'block' : 'none';
    leadError.textContent = message || '';
  }

  function toggleLeadGate(forceOpen) {
    if (!leadGate) return;
    var shouldShow = !!collectLeads && !leadCaptured && !!forceOpen;
    leadGate.classList.toggle('show', shouldShow);
    ci.disabled = shouldShow;
    sb.disabled = shouldShow || !ci.value.trim();
  }

  function submitLead() {
    var payload = {
      chatbotId: config.chatbotId,
      name: String((leadName && leadName.value) || '').trim(),
      email: String((leadEmail && leadEmail.value) || '').trim(),
      phone: String((leadPhone && leadPhone.value) || '').trim(),
    };
    if (!payload.name) return setLeadError('Please enter your name.');
    if (!payload.email && !payload.phone) return setLeadError('Add an email or phone number.');
    setLeadError('');
    leadSubmit.disabled = true;
    fetch((config.apiUrl || '') + '/api/chatbot-public/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function(response) { return response.json(); })
      .then(function(payload) {
        if (payload && payload.error) throw new Error(payload.error.message || 'Failed to save lead');
        leadCaptured = true;
        sessionStorage.setItem(leadKey, JSON.stringify(payload.lead || payload));
        toggleLeadGate(false);
        ci.disabled = false;
        ci.focus();
      })
      .catch(function(err) {
        setLeadError(err.message || 'Failed to save your details.');
      })
      .finally(function() {
        leadSubmit.disabled = false;
      });
  }

  function loadSession() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(sessionKey) || '[]');
      if (!Array.isArray(saved)) return;
      saved.forEach(function(message) {
        if (!message || !message.role || !message.text) return;
        history.push({ role: message.role, text: message.text });
        addMsg(message.role === 'model' ? 'bot' : 'usr', message.text, true);
      });
      if (saved.length > 0) greeted = true;
    } catch (err) {}
  }

  function toggleWidget() {
    isOpen = !isOpen;
    cw.classList.toggle('hide', !isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    icoChat.style.display = isOpen ? 'none' : '';
    icoClose.style.display = isOpen ? '' : 'none';

    if (isOpen && !sessionLoaded) {
      sessionLoaded = true;
      loadLeadState();
      loadSession();
    }
    if (isOpen) {
      toggleLeadGate(collectLeads && !leadCaptured);
    }
    if (isOpen && !greeted) {
      greeted = true;
      setTimeout(function() { addBotMsg(config.welcomeMessage || 'Hello! How can I help you today?'); }, 180);
    }
    if (isOpen) {
      setTimeout(function() { ci.focus(); }, 220);
    }
  }

  function sendMessage(preset) {
    if (sending) return;
    if (collectLeads && !leadCaptured) { toggleLeadGate(true); return; }
    var text = String(preset || ci.value || '').trim();
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
      }, 400);
      return;
    }

    fetch((config.apiUrl || '') + '/api/chatbot-public/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        chatbotId: config.chatbotId,
        history: history.slice(-12),
      }),
    })
      .then(function(response) { return response.json(); })
      .then(function(payload) {
        hideTyping();
        var reply = payload.response || (payload.error && payload.error.message) || "I'm here to help! Could you rephrase that?";
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

  suggestedPrompts.forEach(function(prompt) {
    if (!prompt) return;
    var btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = prompt;
    btn.type = 'button';
    btn.onclick = function() { sendMessage(prompt); };
    chips.appendChild(btn);
  });

  launcher.onclick = toggleWidget;
  if (leadSubmit) leadSubmit.onclick = submitLead;
  xb.onclick = toggleWidget;
  sb.onclick = function() { sendMessage(); };
  ci.oninput = function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    sb.disabled = !this.value.trim();
  };
  ci.onkeydown = function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sb.disabled) sendMessage();
    }
  };
})();
</script>
</body>
</html>`;
}

module.exports = router;
