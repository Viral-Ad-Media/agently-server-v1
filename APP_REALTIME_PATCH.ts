// // ================================================================
// // PATCH for App.tsx — Add Supabase Realtime live dashboard updates
// // ================================================================
// //
// // 1. Install the Supabase client in your agently frontend:
// //    npm install @supabase/supabase-js
// //
// // 2. Add to your frontend .env (NOT .env.example — real values):
// //    VITE_SUPABASE_URL=https://xxx.supabase.co
// //    VITE_SUPABASE_ANON_KEY=eyJ...   ← anon key, safe for frontend
// //
// // 3. Copy frontend-realtime.ts → agently/services/realtime.ts
// //
// // 4. In App.tsx, add this import at the top:
// import { subscribeToOrgRealtime } from './services/realtime';
// //
// // 5. Inside the App component, add this useEffect (after the
// //    existing bootstrap useEffect):

// // ── REALTIME: live dashboard refresh ──────────────────────────
// useEffect(() => {
//   if (!org?.id) return;

//   // refreshWorkspace() is already defined in App.tsx.
//   // This subscribes to Supabase Realtime and refreshes on any change.
//   const unsubscribe = subscribeToOrgRealtime(org.id, {
//     onAny: () => {
//       // Debounce: don't hammer the API if multiple events fire at once
//       void refreshWorkspace();
//     },
//   });

//   return unsubscribe; // cleanup on unmount / org change
// }, [org?.id]);
// // ── END REALTIME PATCH ─────────────────────────────────────────

// // That's it. Now when Vapi calls /api/vapi/webhook and saves a call record
// // to Supabase, the INSERT fires a realtime event, which triggers
// // refreshWorkspace(), which re-fetches /api/bootstrap and updates
// // the dashboard stats, call logs, and leads in real time.
// //
// // The Dashboard component (Dashboard.tsx) uses the dashboard prop
// // already — no changes needed there. The data just updates live.
