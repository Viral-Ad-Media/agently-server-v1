-- ============================================================
-- AGENTLY DATABASE SCHEMA
-- Run this entire file in your Supabase SQL editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  industry TEXT DEFAULT '',
  website TEXT DEFAULT '',
  location TEXT DEFAULT '',
  timezone TEXT DEFAULT 'America/New_York',
  phone_number TEXT DEFAULT '',
  onboarded BOOLEAN DEFAULT FALSE,
  -- Twilio
  twilio_account_sid TEXT DEFAULT '',
  twilio_auth_token_encrypted TEXT DEFAULT '',
  twilio_auth_token_last_four TEXT DEFAULT '',
  twilio_validate_requests BOOLEAN DEFAULT TRUE,
  twilio_webhook_base_url TEXT DEFAULT '',
  -- Subscription
  plan TEXT DEFAULT 'Starter' CHECK (plan IN ('Starter', 'Pro', 'None')),
  subscription_status TEXT DEFAULT 'trialing' CHECK (subscription_status IN ('active', 'canceled', 'past_due', 'trialing')),
  subscription_period_end TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  usage_calls INTEGER DEFAULT 0,
  usage_minutes INTEGER DEFAULT 0,
  call_limit INTEGER DEFAULT 100,
  minute_limit INTEGER DEFAULT 500,
  -- Active agent/chatbot
  active_voice_agent_id UUID,
  active_chatbot_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT DEFAULT '',
  role TEXT DEFAULT 'Owner' CHECK (role IN ('Owner', 'Admin', 'Viewer')),
  avatar TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MAGIC LINK TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOICE AGENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS voice_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT DEFAULT 'My AI Agent',
  direction TEXT DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  twilio_phone_number TEXT DEFAULT '',
  twilio_phone_sid TEXT DEFAULT '',
  voice TEXT DEFAULT 'Zephyr' CHECK (voice IN ('Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir')),
  language TEXT DEFAULT 'English',
  greeting TEXT DEFAULT 'Hello, thank you for calling. How can I help you today?',
  tone TEXT DEFAULT 'Professional' CHECK (tone IN ('Professional', 'Friendly', 'Empathetic')),
  business_hours TEXT DEFAULT '9am-5pm Monday-Friday',
  escalation_phone TEXT DEFAULT '',
  voicemail_fallback BOOLEAN DEFAULT TRUE,
  data_capture_fields JSONB DEFAULT '["name", "phone", "email", "reason"]',
  rules JSONB DEFAULT '{"autoBook": false, "autoEscalate": true, "captureAllLeads": true}',
  -- Vapi integration
  vapi_assistant_id TEXT DEFAULT '',
  vapi_phone_number_id TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AGENT FAQs
-- ============================================================
CREATE TABLE IF NOT EXISTS faqs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  voice_agent_id UUID REFERENCES voice_agents(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CHATBOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS chatbots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  voice_agent_id UUID,
  name TEXT DEFAULT 'My Chatbot',
  header_title TEXT DEFAULT 'Chat with us',
  welcome_message TEXT DEFAULT 'Hello! How can I help you today?',
  placeholder TEXT DEFAULT 'Type your message...',
  launcher_label TEXT DEFAULT 'Chat',
  accent_color TEXT DEFAULT '#4f46e5',
  position TEXT DEFAULT 'right' CHECK (position IN ('left', 'right')),
  avatar_label TEXT DEFAULT 'A',
  custom_prompt TEXT DEFAULT '',
  suggested_prompts JSONB DEFAULT '["What are your hours?", "How do I get started?", "What services do you offer?"]',
  faqs JSONB DEFAULT '[]',
  embed_script TEXT DEFAULT '',
  widget_script_url TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- LEADS
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT DEFAULT 'Unknown',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  source TEXT DEFAULT 'call',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CALL RECORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  voice_agent_id UUID REFERENCES voice_agents(id) ON DELETE SET NULL,
  caller_name TEXT DEFAULT 'Unknown Caller',
  caller_phone TEXT DEFAULT '',
  duration INTEGER DEFAULT 0,
  outcome TEXT DEFAULT 'FAQ Answered',
  summary TEXT DEFAULT '',
  transcript JSONB DEFAULT '[]',
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  -- Vapi call data
  vapi_call_id TEXT DEFAULT '',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CHAT CONVERSATIONS (messenger preview)
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  chatbot_id UUID REFERENCES chatbots(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT DEFAULT 'Paid' CHECK (status IN ('Paid', 'Pending', 'Overdue')),
  pdf_url TEXT DEFAULT '',
  date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONTACT FORM SUBMISSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT DEFAULT '',
  message TEXT NOT NULL,
  type TEXT DEFAULT 'contact' CHECK (type IN ('contact', 'sales')),
  company_name TEXT DEFAULT '',
  expected_volume TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_token ON magic_link_tokens(token);
CREATE INDEX IF NOT EXISTS idx_voice_agents_org ON voice_agents(organization_id);
CREATE INDEX IF NOT EXISTS idx_faqs_org ON faqs(organization_id);
CREATE INDEX IF NOT EXISTS idx_faqs_agent ON faqs(voice_agent_id);
CREATE INDEX IF NOT EXISTS idx_chatbots_org ON chatbots(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_call_records_org ON call_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_call_records_timestamp ON call_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_org ON chat_messages(organization_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chatbot ON chat_messages(chatbot_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) - Optional but recommended
-- Disable for now since we're using service key server-side
-- ============================================================
-- ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- etc.

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_voice_agents_updated_at BEFORE UPDATE ON voice_agents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_faqs_updated_at BEFORE UPDATE ON faqs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_chatbots_updated_at BEFORE UPDATE ON chatbots FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ADDITIONS FOR VAPI + REALTIME (run after initial schema)
-- ============================================================

-- Add vapi_phone_number_id to voice_agents if not exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='voice_agents' AND column_name='vapi_phone_number_id') THEN
    ALTER TABLE voice_agents ADD COLUMN vapi_phone_number_id TEXT DEFAULT '';
  END IF;
END $$;

-- Add recording_url to call_records
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_records' AND column_name='recording_url') THEN
    ALTER TABLE call_records ADD COLUMN recording_url TEXT DEFAULT '';
  END IF;
END $$;

-- Add widget_script_url to chatbots
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chatbots' AND column_name='widget_script_url') THEN
    ALTER TABLE chatbots ADD COLUMN widget_script_url TEXT DEFAULT '';
  END IF;
END $$;

-- ============================================================
-- SUPABASE REALTIME - Enable for dashboard live updates
-- Run these in your Supabase SQL editor
-- ============================================================

-- Enable realtime on the tables the dashboard watches
ALTER PUBLICATION supabase_realtime ADD TABLE call_records;
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE organizations;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- ============================================================
-- HELPER RPC for atomic usage increment
-- ============================================================
CREATE OR REPLACE FUNCTION increment_usage(org_id UUID, calls_inc INT, minutes_inc INT)
RETURNS void AS $$
  UPDATE organizations
  SET usage_calls = usage_calls + calls_inc,
      usage_minutes = usage_minutes + minutes_inc
  WHERE id = org_id;
$$ LANGUAGE sql;
