"use strict";
/*
 * Browser half of Front Desk for the chat widget: appointment-time buttons,
 * owner replies arriving in the chat, and reopening a chat from an email link.
 *
 * Injected into the widget's own IIFE (see api/routes/widget.js), so it can
 * use the widget's names: API, CID, msgs, history, addBotMsg, addMsg,
 * saveSession, renderLeadForm, markLeadCaptured.
 * ES5 only, like the rest of the widget.
 */

const CSS = `
.fdSlots{display:flex;flex-direction:column;gap:6px;margin:4px 0 10px;max-width:86%}
.fdSlots button{font-family:inherit;border:1px solid var(--accent,#0f172a);background:#fff;color:var(--accent,#0f172a);border-radius:12px;padding:9px 12px;font-size:13px;font-weight:600;cursor:pointer;text-align:left}
.fdSlots button:hover{background:rgba(15,23,42,.05)}
.fdSlots button:disabled{opacity:.5;cursor:default}
.fdTeam{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin-bottom:2px}
`;

const SCRIPT = `
  (function () {
    var FD_TOKEN_KEY = 'agently:' + CID + ':mediaToken';
    var FD_SID_KEY = 'agently:' + CID + ':mediaSid';
    var fd = { mem: {}, lastSeen: null, timer: null, human: false, pendingSlot: null, started: false, quietPolls: 0 };

    function store(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { fd.mem[k] = v; } }
    function read(k) { try { return sessionStorage.getItem(k) || fd.mem[k] || ''; } catch (e) { return fd.mem[k] || ''; } }
    function rid() {
      var b = new Uint8Array(16), s = '', i;
      try { (window.crypto || window.msCrypto).getRandomValues(b); }
      catch (e) { for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
      for (i = 0; i < 16; i++) s += ('0' + b[i].toString(16)).slice(-2);
      return s;
    }
    // Media uploads may be switched off for this chatbot; the visit still needs an id.
    if (!window.__agentlyMediaSessionId) {
      window.__agentlyMediaSessionId = function () {
        var v = read(FD_SID_KEY);
        if (!v) { v = rid(); store(FD_SID_KEY, v); }
        return v;
      };
    }
    function leadToken() {
      try { return localStorage.getItem(FD_TOKEN_KEY) || read(FD_TOKEN_KEY); } catch (e) { return read(FD_TOKEN_KEY); }
    }
    window.__agentlyLeadToken = leadToken;
    var origSetToken = window.__agentlySetMediaToken;
    window.__agentlySetMediaToken = function (t) {
      if (!t) return;
      if (origSetToken) origSetToken(t);
      store(FD_TOKEN_KEY, t);
      try { localStorage.setItem(FD_TOKEN_KEY, t); } catch (e) {}
      if (fd.pendingSlot) { var s = fd.pendingSlot; fd.pendingSlot = null; setTimeout(function () { book(s, null); }, 700); }
    };

    function getJson(url) {
      return fetch(url).then(function (r) { return r.json().catch(function () { return {}; }); });
    }
    function postJson(url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    /* ── appointment times ── */
    function renderSlots(slots) {
      if (!slots || !slots.length) return;
      var old = document.querySelectorAll('.fdSlots');
      for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
      var box = document.createElement('div');
      box.className = 'fdSlots';
      slots.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = s.label;
        b.onclick = function () { book(s, box); };
        box.appendChild(b);
      });
      msgs.appendChild(box);
      msgs.scrollTop = msgs.scrollHeight;
    }
    function book(slot, box) {
      if (box) { var bs = box.querySelectorAll('button'); for (var i = 0; i < bs.length; i++) bs[i].disabled = true; }
      var tok = leadToken();
      if (!tok) {
        if (typeof COLLECT_LEADS !== 'undefined' && !COLLECT_LEADS) {
          addBotMsg('To book ' + slot.label + ', please contact the team directly using the details on this website.');
          return;
        }
        fd.pendingSlot = slot;
        addBotMsg('To book ' + slot.label + ', I just need a few quick details.');
        if (typeof renderLeadForm === 'function') renderLeadForm();
        return;
      }
      postJson(API + '/api/chatbot-public/book', { chatbotId: CID, startISO: slot.start, leadToken: tok })
        .then(function (d) {
          if (d && d.success) { addBotMsg(d.message || "You're booked."); return; }
          if (d && d.error && d.error.code === 'LEAD_REQUIRED') {
            fd.pendingSlot = slot;
            addBotMsg(d.error.message);
            if (typeof renderLeadForm === 'function') renderLeadForm();
            return;
          }
          addBotMsg((d && d.message) || (d && d.error && d.error.message) || "I couldn't book that time. Please try another.");
          if (d && d.slots) renderSlots(d.slots);
        })
        .catch(function () { addBotMsg("I couldn't reach the calendar just now. Please try again in a moment."); });
    }

    /* ── owner replies ── */
    function showTeamMsg(m) {
      var el = addBotMsg(m.body);
      try {
        var tag = document.createElement('div');
        tag.className = 'fdTeam';
        tag.textContent = 'Team';
        el.insertBefore(tag, el.firstChild);
      } catch (e) {}
    }
    function poll() {
      fd.timer = null;
      if (document.hidden) { schedule(); return; }
      var url = API + '/api/chatbot-public/conversation?chatbotId=' + encodeURIComponent(CID) +
        '&sessionId=' + encodeURIComponent(window.__agentlyMediaSessionId()) +
        (fd.lastSeen ? '&after=' + encodeURIComponent(fd.lastSeen) : '');
      getJson(url).then(function (d) {
        var got = 0;
        fd.human = !!(d && d.status === 'human');
        ((d && d.messages) || []).forEach(function (m) {
          if (!fd.lastSeen || m.createdAt > fd.lastSeen) fd.lastSeen = m.createdAt;
          if (m.role === 'owner') { got++; showTeamMsg(m); }
        });
        fd.quietPolls = got ? 0 : fd.quietPolls + 1;
      }).catch(function () {}).then(schedule);
    }
    function schedule() {
      if (fd.timer || !fd.started) return;
      // Quick while a person is in the chat or the customer was just active,
      // slower after two quiet minutes, and stop after about twenty.
      if (!fd.human && fd.quietPolls > 70) return;
      fd.timer = setTimeout(poll, fd.human ? 5000 : (fd.quietPolls < 15 ? 8000 : 20000));
    }
    function start() {
      if (!fd.lastSeen) fd.lastSeen = new Date().toISOString();
      fd.started = true;
      fd.quietPolls = 0;
      schedule();
    }

    window.__agentlyFrontdesk = {
      // Called with the server's answer to a chat message or a photo.
      afterReply: function (d) {
        start();
        if (d && d.human) { fd.human = true; if (fd.timer) { clearTimeout(fd.timer); fd.timer = null; } schedule(); }
        if (d && d.slots) renderSlots(d.slots);
      }
    };

    /* ── reopen a chat from the link in a reply email ── */
    var resume = '';
    try { resume = new URLSearchParams(window.location.search).get('resume') || ''; } catch (e) {}
    if (resume) {
      getJson(API + '/api/chatbot-public/conversation?chatbotId=' + encodeURIComponent(CID) + '&resume=' + encodeURIComponent(resume))
        .then(function (d) {
          if (!d || !d.sessionId) return;
          store(FD_SID_KEY, d.sessionId);
          if (d.mediaToken) { window.__agentlySetMediaToken(d.mediaToken); if (typeof markLeadCaptured === 'function') markLeadCaptured(); }
          history.length = 0;
          msgs.innerHTML = '';
          (d.messages || []).forEach(function (m) {
            if (m.createdAt && (!fd.lastSeen || m.createdAt > fd.lastSeen)) fd.lastSeen = m.createdAt;
            if (!m.body) return;
            if (m.role === 'visitor') { history.push({ role: 'user', text: m.body }); addMsg('usr', m.body, true); }
            else if (m.role === 'owner') showTeamMsg(m);
            else { history.push({ role: 'model', text: m.body }); addMsg('bot', m.body, true); }
          });
          try { greeted = true; sessionLoaded = true; } catch (e) {}
          if (typeof saveSession === 'function') saveSession();
          fd.human = d.status === 'human';
          start();
        }).catch(function () {});
    }
  })();
`;

module.exports = { CSS, SCRIPT };
