const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

let audioContext: AudioContext | null = null;

export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/** نغمة واحدة في تتابع: تردّدها، وإزاحتها عن البداية، وطولها، وذروة علوّها. */
type ToneStep = {
  frequency: number;
  offsetSeconds: number;
  durationSeconds: number;
  peakVolume: number;
};

/** تتابع **صاعد**: انتهى الدور وردُّه جاهز. */
const COMPLETION_TONES: readonly ToneStep[] = [
  { frequency: 740, offsetSeconds: 0, durationSeconds: 0.12, peakVolume: 0.075 },
  { frequency: 988, offsetSeconds: 0.11, durationSeconds: 0.16, peakVolume: 0.06 },
];

/**
 * تتابع **هابط**: الجولة انتهت بفشل (‏T-1294).
 *
 * الهبوط هو الفارق المسموع كلّه — نفس الطول ونفس العلوّ ونفس المفتاح في
 * الإعدادات، فلا يظنّ سامعُه أنّ ردّاً وصل. ولا مفتاح إعداد ثانٍ عمداً (قرار
 * المالك): قناة إشعار واحدة بمفتاح واحد.
 */
const ERROR_TONES: readonly ToneStep[] = [
  { frequency: 988, offsetSeconds: 0, durationSeconds: 0.12, peakVolume: 0.075 },
  { frequency: 622, offsetSeconds: 0.11, durationSeconds: 0.16, peakVolume: 0.06 },
];

const playToneSequence = async (
  steps: readonly ToneStep[],
  force: boolean,
): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    for (const step of steps) {
      playTone(
        context,
        step.frequency,
        now + step.offsetSeconds,
        step.durationSeconds,
        step.peakVolume,
      );
    }
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

export const playChatCompletionSound = async ({ force = false } = {}): Promise<void> =>
  playToneSequence(COMPLETION_TONES, force);

export const playChatErrorSound = async ({ force = false } = {}): Promise<void> =>
  playToneSequence(ERROR_TONES, force);
