# Front Desk camera and recordings — 13 November 2026

Integrated the media changes from the detached `agently-wt-frontdesk-camera`
and `agently-server-wt-frontdesk-camera` working copies into the active
`agently` and `agently-server` directories, preserving existing local changes.

## Available behavior

- Public chat widget: take a photo, switch camera, record a short video with
  audio where available, or choose a file. Preview and add a note before sending.
- Video recording stops after 15 seconds. Video AI analysis uses extracted
  still frames, not the audio track. The owner can play the original clip.
- Camera streams are released when capture closes, the widget closes, or the
  page is hidden. Late permission responses and superseded camera requests are
  discarded. File-size and readable-duration checks run before upload.
- Messenger: per-chatbot upload toggle and a “Test camera & video” link that
  opens the actual saved widget. Save customization before testing changes.
- Both Leads views, including the active LeadsInbox drawer, display the media
  gallery and AI findings. Deletion remains restricted by the backend to admins.
- Failed media-row insertion attempts to remove the uploaded object. Expired
  uploads and disabled chatbots cannot be analyzed. Video duration metadata is
  client supplied; the server does not decode video to independently verify it.

## Verification

- Backend: 359 tests passed; syntax check passed for 212 JavaScript files.
- Frontend: TypeScript check passed.
- Full frontend build and Vitest startup blocked by this Windows environment's
  child-process launch restriction (`spawn EPERM` from esbuild). They must run
  in an environment allowing the normal build processes before release.
- Read-only checks against the configured database verified `chat_media`,
  `chatbots.media_uploads_enabled`, and the private `chat-media` bucket with
  a 27,262,976-byte limit. No database changes were needed in this session.
- Real device camera/microphone capture and live AI upload were not exercised.

## Release

Changes are local and uncommitted; no deployment was performed. Both active
repositories also contain substantial unrelated ongoing work. Review and
isolate the intended release rather than staging every changed file.

For a new environment apply `migrations/20261113_chat_media.sql` before serving
the feature. Existing environments should verify the table, column, bucket,
and triggers before applying migrations. Ensure HTTPS and iframe camera and
microphone permissions; regenerate old embed code where those are missing.
Pending media expires after 24 hours; physical cleanup is opportunistic on
subsequent uploads, not a guaranteed job at the exact expiry time.
