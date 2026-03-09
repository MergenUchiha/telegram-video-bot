export const MAIN_MENU_TEXT =
  '🎬 <b>Что делаем?</b>\n\n' +
  '• <b>Spanish Jokes Auto</b> — бот сам возьмёт анекдот, фон и музыку, сделает ролик\n' +
  '• <b>Стандартный рендер</b> — ты отправляешь видео, настраиваешь TTS / субтитры / звук';

export const PRESETS = ['default', 'dark', 'light', 'minimal'] as const;
export type TextCardPreset = (typeof PRESETS)[number];

export const AUDIO_POLICIES = ['REPLACE', 'DUCK', 'MUTE', 'KEEP'] as const;
export type AudioPolicy = (typeof AUDIO_POLICIES)[number];
