# Agently Backend

A production-ready Node.js/Express backend for the Agently AI Receptionist platform. Built to run as a Vercel serverless function with Supabase for data persistence.

---

## Architecture

```
agently-server/
├── api/
│   ├── index.js              ← Vercel serverless entry & Express app
│   └── routes/
│       ├── auth.js           ← Login, register, magic link, logout
│       ├── bootstrap.js      ← Full workspace state (GET /api/bootstrap)
│       ├── onboarding.js     ← FAQ generation, onboarding complete
│       ├── agent.js          ← Active agent PATCH + FAQ CRUD + restart
│       ├── voice-agents.js   ← Multi-agent CRUD + activate/delete
│       ├── chatbots.js       ← Chatbot CRUD + embed script
│       ├── messenger.js      ← Chat preview with OpenAI
│       ├── calls.js          ← Simulate call, download report
│       ├── leads.js          ← Lead CRUD + CSV export
│       ├── misc.js           ← Team, billing, settings, contact
│       ├── widget.js         ← Embeddable chatbot HTML iframe
│       └── chatbot-public.js ← Public chat API (no auth)
├── lib/
│   ├── supabase.js           ← Supabase client singleton
│   ├── auth.js               ← JWT sign/verify/resolve
│   ├── serializers.js        ← DB row → frontend type mappers
│   ├── dashboard.js          ← Dashboard stats builder
│   ├── openai.js             ← FAQ gen, chat, call summary
│   ├── email.js              ← Resend email helpers
│   └── vapi.js               ← Vapi voice AI integration
├── middleware/
│   ├── auth.js               ← requireAuth, requireAdmin, requireOwner
│   └── error.js              ← asyncHandler, global error handler
├── supabase-schema.sql       ← Run once in Supabase SQL editor
├── vercel.json               ← Vercel deployment config
├── dev-server.js             ← Local dev (node dev-server.js)
└── .env.example              ← All required env vars
```

---

## Step 1: Supabase Setup

1. Go to [supabase.com](https://supabase.com) → New project
2. Open **SQL Editor** → paste the entire contents of `supabase-schema.sql` → **Run**
3. Go to **Settings → API** and copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_KEY`

---

## Step 2: Get Your API Keys

| Service      | Where to Get It                                                               |
| ------------ | ----------------------------------------------------------------------------- |
| **OpenAI**   | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)          |
| **Resend**   | [resend.com/api-keys](https://resend.com/api-keys) — verify your domain first |
| **Vapi**     | [dashboard.vapi.ai](https://dashboard.vapi.ai) → Account → API Keys           |
| **Supabase** | Settings → API in your project                                                |

---

## Step 3: Deploy Backend to Vercel

### Option A: Vercel CLI (recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# From the agently-server directory
cd agently-server
vercel

# Follow prompts, then add env vars:
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_KEY
vercel env add JWT_SECRET
vercel env add OPENAI_API_KEY
vercel env add RESEND_API_KEY
vercel env add RESEND_FROM_EMAIL
vercel env add VAPI_API_KEY
vercel env add APP_URL          # your frontend URL e.g. https://agently.vercel.app
vercel env add API_URL          # this backend URL e.g. https://agently-server.vercel.app
vercel env add ALLOWED_ORIGINS  # comma-separated frontend origins

# Deploy to production
vercel --prod
```

### Option B: Vercel Dashboard

1. Push `agently-server/` to a GitHub repo
2. Vercel → New Project → Import that repo
3. Add all environment variables in **Settings → Environment Variables**
4. Deploy

**Note your backend URL** — you'll need it for the frontend.

---

## Step 4: Deploy Frontend to Vercel

1. Push the `agently/` (frontend) folder to a separate GitHub repo
2. Vercel → New Project → Import it
3. Add this environment variable:
   ```
   VITE_API_BASE_URL=https://your-backend.vercel.app
   ```
4. Deploy

---

## Step 5: Update CORS

Once both are deployed, go back to your **backend** Vercel project → Settings → Environment Variables → update:

```
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

Redeploy the backend.

---

## Local Development

```bash
# 1. Clone & install
cd agently-server
npm install

# 2. Copy env file
cp .env.example .env
# Fill in your values

# 3. Start backend
npm run dev
# → http://localhost:4000

# 4. In another terminal, start frontend
cd ../agently
npm run dev
# → http://localhost:3000
```

The frontend's `vite.config.ts` proxies `/api` → `http://localhost:4000` automatically.

---

## API Reference

### Auth (no auth required)

| Method | Path                          | Description            |
| ------ | ----------------------------- | ---------------------- |
| POST   | `/api/auth/login`             | Email + password login |
| POST   | `/api/auth/register`          | Create account + org   |
| POST   | `/api/auth/magic-link`        | Send magic link email  |
| POST   | `/api/auth/magic-link/verify` | Exchange token for JWT |
| POST   | `/api/auth/logout`            | Invalidate session     |

### Workspace

| Method | Path                       | Description                |
| ------ | -------------------------- | -------------------------- |
| GET    | `/api/bootstrap`           | Full workspace state       |
| POST   | `/api/onboarding/faqs`     | Generate FAQs from website |
| POST   | `/api/onboarding/complete` | Finish onboarding          |

### Agent

| Method | Path                   | Description            |
| ------ | ---------------------- | ---------------------- |
| PATCH  | `/api/agent`           | Update active agent    |
| POST   | `/api/agent/restart`   | Resync agent to Vapi   |
| POST   | `/api/agent/faqs`      | Add FAQ                |
| PATCH  | `/api/agent/faqs/:id`  | Update FAQ             |
| DELETE | `/api/agent/faqs/:id`  | Delete FAQ             |
| POST   | `/api/agent/faqs/sync` | Re-scrape website FAQs |

### Voice Agents (multi-agent)

| Method | Path                             | Description         |
| ------ | -------------------------------- | ------------------- |
| POST   | `/api/voice-agents`              | Create voice agent  |
| PATCH  | `/api/voice-agents/:id`          | Update voice agent  |
| POST   | `/api/voice-agents/:id/activate` | Set as active agent |
| DELETE | `/api/voice-agents/:id`          | Delete voice agent  |

### Chatbots

| Method | Path                         | Description           |
| ------ | ---------------------------- | --------------------- |
| POST   | `/api/chatbots`              | Create chatbot        |
| PATCH  | `/api/chatbots/:id`          | Update chatbot        |
| POST   | `/api/chatbots/:id/activate` | Set as active chatbot |
| DELETE | `/api/chatbots/:id`          | Delete chatbot        |
| GET    | `/api/chatbots/:id/embed`    | Get embed script      |

### Calls & Leads

| Method | Path                    | Description          |
| ------ | ----------------------- | -------------------- |
| POST   | `/api/calls/simulate`   | Save simulated call  |
| GET    | `/api/calls/:id/report` | Download call report |
| POST   | `/api/leads`            | Create lead          |
| PATCH  | `/api/leads/:id`        | Update lead          |
| GET    | `/api/leads/export.csv` | Download CSV         |

### Messenger

| Method | Path                      | Description        |
| ------ | ------------------------- | ------------------ |
| POST   | `/api/messenger/messages` | Send chat message  |
| DELETE | `/api/messenger/messages` | Reset conversation |

### Team, Billing, Settings

| Method | Path                                 | Description           |
| ------ | ------------------------------------ | --------------------- |
| POST   | `/api/team/invitations`              | Invite team member    |
| DELETE | `/api/team/members/:id`              | Remove member         |
| PATCH  | `/api/billing/plan`                  | Change plan           |
| POST   | `/api/billing/cancel`                | Cancel subscription   |
| GET    | `/api/billing/invoices/:id/download` | Download invoice      |
| PATCH  | `/api/settings`                      | Update org settings   |
| POST   | `/api/contact`                       | Contact form (public) |
| POST   | `/api/contact-sales`                 | Sales inquiry         |

### Public (no auth)

| Method | Path                       | Description                   |
| ------ | -------------------------- | ----------------------------- |
| GET    | `/chatbot-widget/:id`      | Embeddable iframe widget HTML |
| POST   | `/api/chatbot-public/chat` | Widget chat API               |
| GET    | `/health`                  | Health check                  |

---

## Chatbot Embed

When a user creates a chatbot in the dashboard, they get an embed script like:

```html
<iframe
  id="agently-chatbot-{id}"
  src="https://your-backend.vercel.app/chatbot-widget/{id}"
  style="position:fixed;bottom:20px;right:20px;width:420px;height:700px;max-width:90vw;max-height:90vh;border:none;background:transparent;z-index:1000000;overflow:hidden;"
  scrolling="no"
  frameborder="0"
  allow="microphone"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-storage-access-by-user-activation"
></iframe>
```

Each chatbot gets its own unique iframe served directly from your backend URL. The widget uses the chatbot's configured colors, FAQs, welcome message, and calls `/api/chatbot-public/chat` for AI responses.

---

## Vapi Voice Integration

When `VAPI_API_KEY` is set:

- Creating/updating a voice agent automatically creates/updates a Vapi assistant
- The assistant gets the agent's greeting, FAQs, tone, and escalation logic
- Vapi handles actual phone calls via Twilio phone numbers
- Call data flows back to your backend via webhooks (configure in Vapi dashboard)

**Vapi Webhook URL** (set in Vapi dashboard):

```
https://your-backend.vercel.app/api/calls/simulate
```

---

## Environment Variables Reference

```env
# Required
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
JWT_SECRET=at-least-32-random-characters

# OpenAI (required for FAQ gen + chat)
OPENAI_API_KEY=sk-...

# Resend (required for magic links + team invites)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=hello@yourdomain.com
RESEND_FROM_NAME=Agently

# Vapi (optional - enables real voice calls)
VAPI_API_KEY=...

# URLs (required in production)
APP_URL=https://your-frontend.vercel.app
API_URL=https://your-backend.vercel.app
ALLOWED_ORIGINS=https://your-frontend.vercel.app

# Dev only
NODE_ENV=development
DEV_SEED_TOKEN=any-string-for-local-testing
```
