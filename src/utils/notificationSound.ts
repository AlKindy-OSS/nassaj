const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';
/** مفتاح صوت الأسئلة (‏T-2041) — مستقلّ عن صوت الانتهاء، ومُفعَّل افتراضياً مثله. */
export const NOTIFICATION_QUESTION_SOUND_ENABLED_STORAGE_KEY = 'notificationQuestionSoundEnabled';
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

export const isNotificationQuestionSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_QUESTION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

export const setNotificationQuestionSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_QUESTION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/**
 * سياسة التشغيل التلقائي: لا صوت قبل أول تفاعلٍ من المستخدم مع الصفحة.
 * المحاولة قبله تُرفض أو تُعلّق `AudioContext` وتملأ السجلّ تحذيرات، فيُصمت
 * عنها بصمت. ‏`navigator.userActivation` هو الحكم حيث يتوفّر، وإلا فمستمعٌ محلّي.
 */
let sawUserGesture = false;

if (typeof window !== 'undefined') {
  const markGesture = () => {
    sawUserGesture = true;
    window.removeEventListener('pointerdown', markGesture, true);
    window.removeEventListener('keydown', markGesture, true);
  };
  window.addEventListener('pointerdown', markGesture, true);
  window.addEventListener('keydown', markGesture, true);
}

export const hasUserGesture = (): boolean => {
  const activation = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
    : undefined;
  return sawUserGesture || activation?.hasBeenActive === true;
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

/**
 * تتابع **نبضتين متساويتين ثم أعلى**: سؤالٌ ينتظر جوابك (‏T-2041).
 * يختلف عن الصاعد (رد جاهز) والهابط (فشل) فيُميَّز بالسمع وحده.
 */
const QUESTION_TONES: readonly ToneStep[] = [
  { frequency: 880, offsetSeconds: 0, durationSeconds: 0.09, peakVolume: 0.07 },
  { frequency: 880, offsetSeconds: 0.14, durationSeconds: 0.09, peakVolume: 0.07 },
  { frequency: 1319, offsetSeconds: 0.28, durationSeconds: 0.18, peakVolume: 0.06 },
];

const playToneSequence = async (
  steps: readonly ToneStep[],
  isEnabled: (() => boolean) | null,
): Promise<void> => {
  if (isEnabled && !isEnabled()) {
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
  playToneSequence(COMPLETION_TONES, force ? null : isNotificationSoundEnabled);

export const playChatErrorSound = async ({ force = false } = {}): Promise<void> =>
  playToneSequence(ERROR_TONES, force ? null : isNotificationSoundEnabled);

/**
 * نغمة السؤال. بلا `force` تحترم مفتاحها وسياسة التشغيل التلقائي معاً؛
 * و`force` لزرّ التجربة في الإعدادات (وهو نفسه تفاعلٌ من المستخدم).
 */
export const playChatQuestionSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !hasUserGesture()) {
    return;
  }
  return playToneSequence(QUESTION_TONES, force ? null : isNotificationQuestionSoundEnabled);
};
