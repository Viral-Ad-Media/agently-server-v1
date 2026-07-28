"use strict";

const CHATBOT_AVATAR_PREFIX = "agently-avatar:";
const CHATBOT_AVATAR_UPLOAD_PREFIX = "agently-upload:";
const CHATBOT_AVATAR_URL_PREFIX = "agently-upload-url:";

const DEFAULT_BACKEND_URL = "https://agently-server-v1.vercel.app";
const FRONTEND_ONLY_HOSTS = new Set([
  "www.agentlycall.com",
  "agentlycall.com",
  "agentlycall.vercel.app",
  "agently-frontend-v1.vercel.app",
]);

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function isFrontendOnlyUrl(value) {
  const host = getHost(value);
  return Boolean(host && FRONTEND_ONLY_HOSTS.has(host));
}

function getRequestBaseUrl(req) {
  if (!req) return "";
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return "";
  return cleanBaseUrl(`${String(proto).split(",")[0]}://${String(host).split(",")[0]}`);
}

function firstBackendUrl(candidates) {
  for (const candidate of candidates) {
    const cleaned = cleanBaseUrl(candidate);
    if (!cleaned) continue;
    if (isFrontendOnlyUrl(cleaned)) continue;
    return cleaned;
  }
  return "";
}

function getApiBaseUrl(req) {
  return firstBackendUrl([
    process.env.API_URL,
    process.env.PUBLIC_API_URL,
    process.env.BACKEND_URL,
    getRequestBaseUrl(req),
    DEFAULT_BACKEND_URL,
  ]);
}

function htmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeComment(value) {
  return String(value || "My Chatbot").replace(/-->/g, "");
}

function getChatLanguages(chatbot) {
  return Array.isArray(chatbot?.chat_languages)
    ? chatbot.chat_languages
    : Array.isArray(chatbot?.chatLanguages)
      ? chatbot.chatLanguages
      : ["en"];
}

function getChatVoice(chatbot) {
  return chatbot?.chat_voice || chatbot?.chatVoice || "alloy";
}

function buildWidgetUrl(chatbot, apiUrl) {
  const base = cleanBaseUrl(apiUrl || getApiBaseUrl());
  const id = chatbot?.id || "";
  const url = `${base}/chatbot-widget/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  const langs = getChatLanguages(chatbot).filter(Boolean).join(",");
  const voice = getChatVoice(chatbot);
  if (langs) params.set("langs", langs);
  if (voice) params.set("voice", voice);
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function buildResponsiveEmbed(chatbot, widgetUrl) {
  const id = `agently-widget-${chatbot.id}`;
  const pos = chatbot.position === "left" ? "left" : "right";
  const safeName = safeComment(chatbot.name || chatbot.header_title || chatbot.headerTitle || "My Chatbot");
  const escapedWidgetUrl = htmlAttr(widgetUrl);
  const lockSide = pos === "left" ? "left:16px;right:auto;" : "right:16px;left:auto;";
  const mobileSide = pos === "left" ? "left:12px!important;right:12px!important;" : "right:12px!important;left:12px!important;";

  return `<!-- Agently Chat Widget for: ${safeName} -->
<style>
  #${id}{
    position:fixed;
    bottom:16px;
    ${lockSide}
    width:72px;
    height:72px;
    border:0;
    background:transparent;
    z-index:2147483646;
    overflow:visible;
    outline:none;
    display:block;
    border-radius:999px;
    transition:width .24s ease,height .24s ease,border-radius .24s ease,top .24s ease,bottom .24s ease,right .24s ease,left .24s ease;
  }
  #${id}[data-agently-open="true"]{
    width:min(390px,calc(100vw - 32px));
    height:min(640px,calc(100dvh - 32px));
    border-radius:22px;
    overflow:hidden;
    box-shadow:0 18px 54px rgba(15,23,42,.22);
  }
  @media (max-width:640px){
    #${id}[data-agently-open="true"]{
      top:12px!important;
      bottom:12px!important;
      ${mobileSide}
      width:auto!important;
      height:auto!important;
      max-width:none!important;
      max-height:none!important;
      border-radius:22px!important;
    }
  }
</style>
<iframe
  id="${id}"
  src="${escapedWidgetUrl}"
  scrolling="no"
  frameborder="0"
  allow="microphone *; camera *; autoplay *; clipboard-write *"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
  referrerpolicy="no-referrer-when-downgrade"
  loading="eager"
  title="Chat widget"
></iframe>
<script>
(function(){
  var el=document.getElementById("${id}");
  if(!el)return;
  var origin;
  try{origin=new URL("${escapedWidgetUrl}").origin;}catch(e){origin="*";}
  window.addEventListener("message",function(ev){
    if(origin!=="*"&&ev.origin!==origin)return;
    var d=ev.data;
    if(!d||d.channel!=="agently-widget"||d.widgetId!=="${chatbot.id}")return;
    if(d.type==="open")el.setAttribute("data-agently-open","true");
    if(d.type==="close")el.removeAttribute("data-agently-open");
    if(window.matchMedia&&window.matchMedia("(max-width:640px)").matches){
      document.documentElement.style.overflow=d.type==="open"?"hidden":"";
      document.body.style.overflow=d.type==="open"?"hidden":"";
    }
  },false);
})();
</script>`;
}

function buildEmbedForChatbot(chatbot, apiUrl) {
  const widgetUrl = buildWidgetUrl(chatbot, apiUrl);
  return {
    widgetUrl,
    embedScript: buildResponsiveEmbed(chatbot, widgetUrl),
  };
}

module.exports = {
  CHATBOT_AVATAR_PREFIX,
  CHATBOT_AVATAR_UPLOAD_PREFIX,
  CHATBOT_AVATAR_URL_PREFIX,
  cleanBaseUrl,
  getApiBaseUrl,
  buildWidgetUrl,
  buildResponsiveEmbed,
  buildEmbedForChatbot,
};
