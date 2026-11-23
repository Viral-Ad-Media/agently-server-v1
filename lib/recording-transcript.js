"use strict";

function recordingPhase(source) {
  return /dial/i.test(String(source || "")) ? "human_transfer" : "agent";
}

function recordingTranscriptLines(tx, { recordingSid, source, startedAt, now = new Date().toISOString() }) {
  const phase = recordingPhase(source);
  const segments = Array.isArray(tx.raw?.segments) ? tx.raw.segments : [];
  const speakerSegments = segments.filter(s => s.speaker !== undefined && s.text);
  if (speakerSegments.length) return speakerSegments.map(s => ({
    role: "transcription", speaker: `Speaker ${String(s.speaker)}${phase === "human_transfer" ? " (human transfer)" : ""}`,
    text: String(s.text).trim(), recording_sid: recordingSid, phase,
    start_seconds: Number(s.start) || 0, end_seconds: Number(s.end) || 0,
    ts: Number.isFinite(Date.parse(startedAt)) ? new Date(Date.parse(startedAt) + (Number(s.start) || 0) * 1000).toISOString() : now,
  }));
  return tx.text ? [{ role: "transcription", speaker: phase === "human_transfer" ? "Caller and representative / manager" : "Full call recording", text: tx.text, recording_sid: recordingSid, phase, ts: now }] : [];
}

function mergeRecordingTranscript(existing, tx, context) {
  const lines = Array.isArray(existing) ? existing : [];
  if (lines.some(l => l.recording_sid === context.recordingSid)) return lines;
  // Live AI turns stay intact. Human conversations must be appended even when
  // the AI portion already has a transcript; previously they were discarded.
  const additions = recordingTranscriptLines(tx, context);
  return context.source && recordingPhase(context.source) === "human_transfer" || lines.length === 0
    ? [...lines, ...additions] : lines;
}

module.exports = { recordingPhase, recordingTranscriptLines, mergeRecordingTranscript };
