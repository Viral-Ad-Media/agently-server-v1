# Voice incident and local UI update — 20 October 2026

## Confirmed findings

- The 19 October outbound call reached Twilio but its TwiML, call-status and AMD callbacks targeted the retired `agently-server-v1.vercel.app` host. Twilio reported HTTP 404 / error 11200 and played its application-error message. The carrier call lasted four seconds. Agently remained queued because its status callback also failed.
- The live AWS deployment environment already had the correct API URL. The laptop's `agently-server/.env` still referenced the retired host; that local setting is now corrected. A shared backend URL resolver additionally maps that retired hostname to the AWS API for all API Twilio callback builders.
- The older local Node API process on port 4000 was verified and restarted to load the fix. Its routes mounted successfully; the local callback base and voice websocket URL now both point at the AWS services.
- The 15 October Timi transcript and recovered recording confirmed that the opening recited the raw operator instructions. The API prepared that greeting before the websocket server's rewrite could run. Intent-aware preparation now also runs before dialing, and the API's deterministic fallback now uses the same protection against long instruction readouts as the voice service.
- The private `call-recordings` storage bucket did not exist. Existing recordings failed archiving with `Bucket not found`, which also prevented transcription. The private bucket is created and verified; archiving failure no longer prevents transcription.
- Human-transfer TwiML did not explicitly record its Dial leg, and recording transcripts were discarded whenever live AI turns already existed. Transfer legs now use dual-channel recording, retain per-recording metadata/transcripts, and append human conversation without replacing the AI conversation.
- A resumed media stream could overwrite prior transcript turns. Transcript saving now merges earlier turns and recording segments, with duplicate protection.
- Outbound message capture could fall back to the business line as the customer's callback number. Message capture and call insights now use the outbound recipient number; missing recipient details stay unknown.

## Behavior changes

The agent acknowledges a concern, offers useful help and one message/callback alternative, and waits for the caller's decision. Accepted messages collect available contact details and use the existing capture tool. A caller who insists on a person is transferred without mandatory contact details or repeated attempts to dissuade them. Transfer refusals and a clear later confirmation are handled explicitly. Existing working-hour checks and unanswered-transfer retry limits remain in place.

The runtime guard combines explicit refusal/confirmation checks with structured choices from the voice model, so English keyword matching is not the only way to transfer. A non-English request and refusal cases have regression coverage; real spoken escalation in each supported language remains a human acceptance check.

## Production and recovery

- API: Lightsail deployment **50**, image `:agently-ingest.api.50`, verified RUNNING with HTTP 200 health; 45 mounted routes, no observed mount failures. Existing ingestion worker image, service scale, environment and health settings preserved.
- Voice: final deployment **20**, image `:agently-calls.ws-server.53`, verified RUNNING with HTTP 200 health and no observed startup/mount failures. Image digest `sha256:6935dc93b4a0d7bfdc92e67cb959460609c3c7824e063133aed0d880e37b89ff`. Earlier deployments 18 and 19 were intermediate updates. All 108 environment variables, the small x2 service size and endpoints were preserved.
- The known 19 October failed call was reconciled from queued to failed using the exact Twilio error and completed four-second carrier-call evidence. No billing adjustment or replacement phone call was made.
- The user explicitly approved sending the existing 15 October Timi audio to OpenAI for recovery/transcription and saving it in production. That recording is now privately archived with a completed full-recording transcript. It ends after the caller asks for a person and a final hello; no substantive manager conversation exists in that recording.

## Frontend stays local

No frontend push or deployment was made. Shared typography, warm surfaces and orange accents now follow the redesigned landing page. The local dashboard labels wrap rather than clip. Call Logs offers live AI versus full-recording/transfer transcript selection and authenticated playback of each archived recording. The recovered Timi transcript and playable audio were verified in the signed-in local browser. Call details retain their original timestamp when the detail response omits it.

Taste skills are present under the outer workspace `skills/taste-skill`, `skills/taste-skill-v1`, and `skills/redesign-skill`. The existing-app redesign guide was used for the local UI work.

## Validation

- API: **332/332 tests**, including callback URL regression, transfer recording, transcript preservation, duplicate callbacks and transcription despite archive failure. The exact API production image passed the suite on Node 20. Syntax check passed for 203 JavaScript files.
- Voice: **49/49 tests**, including escalation choice/refusal, non-English structured choice, outbound customer contact selection, transfer recording and transcript preservation after a resumed stream. The exact final production image passed all 49 tests on Node 20 before upload.
- Frontend: existing suite **63/63**, plus the new recording-selector integration test **1/1**. Final type check and local build passed. The build retains the existing large-chunk warning; no frontend deployment was made. Dashboard labels, recovered full transcript selection and archived audio loading were inspected in the signed-in local browser.
- Remaining human acceptance: a fresh real phone conversation exercising the rewritten opening, message capture, insisted transfer, representative conversation and unanswered-transfer return. No new phone call was initiated by this work.

Changes remain in the existing working trees alongside earlier uncommitted work. Do not mistake a Git HEAD alone for the full deployed source; the API manifest and tested Docker images identify the released state.
