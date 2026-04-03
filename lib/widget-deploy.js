'use strict';

/**
 * widget-deploy.js
 *
 * This module is NOT needed for production.
 * The correct architecture is: your Vercel backend serves /chatbot-widget/:id directly.
 * Each chatbot gets its embed script pointing to that URL.
 *
 * This file is kept as a placeholder in case you later want to push
 * widget snapshots to a CDN, but it is not called anywhere in the live codebase.
 */

function buildWidgetUrl(chatbotId) {
  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
  return `${apiUrl}/chatbot-widget/${chatbotId}`;
}

module.exports = { buildWidgetUrl };
