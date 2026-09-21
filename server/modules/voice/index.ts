/**
 * Voice module barrel (ADR-103 / T-1246).
 *
 * Accurate speech-to-text behind the operator's own key. Everything outside this
 * module imports from here, so the split between what is safe to serve (a
 * boolean saying a key exists) and the key itself stays an internal detail.
 */
export { default as voiceRoutes, createVoiceRouter } from './voice.routes.js';
export {
  isVoiceTranscriptionEnabled,
  readVoiceTranscriptionConfig,
  HARD_MAX_MB as VOICE_TRANSCRIPTION_HARD_MAX_MB,
} from './voice-transcription.service.js';
