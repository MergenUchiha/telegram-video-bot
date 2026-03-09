import * as path from 'node:path';
import type { RenderSession } from '@prisma/client';

export const standardPanelText = (session: RenderSession): string => {
  const hasVideo = Boolean(session.sourceVideoKey);

  if (!hasVideo) {
    return (
      '🎬 <b>Стандартный рендер</b>\n\n' +
      '📎 Отправь видео в этот чат, чтобы начать\n\n' +
      '<i>Поддерживается видео до 200 МБ. После загрузки появятся настройки обработки.</i>'
    );
  }

  const tts = Boolean(session.ttsEnabled);
  const subs = session.subtitlesMode ?? 'NONE';
  const audio = session.originalAudioPolicy ?? 'DUCK';
  const duckDb = session.customDuckDb ?? -18;
  const comment = session.overlayComment;

  const audioLabel: Record<string, string> = {
    REPLACE: 'Replace — заменить на TTS',
    DUCK: `Duck — приглушить на ${duckDb} dB`,
    MUTE: 'Mute — убрать звук',
    KEEP: 'Keep — оставить оригинал',
  };

  const lines = [
    '🎬 <b>Стандартный рендер</b> — настройки\n',
    `🎥 Видео: ✅`,
    `🔊 Звук: ${audioLabel[audio] ?? audio}`,
    `🗣 TTS: ${tts ? '✅ включён' : '○ выключен'}`,
  ];

  if (tts) {
    lines.push(
      `   • Язык: ${session.language ?? 'auto'}  |  Голос: ${session.voiceId ?? 'default'}  |  Скорость: ${session.ttsSpeed != null ? session.ttsSpeed + 'x' : '1.0x'}`,
      `   • Субтитры: ${subs}`,
    );
  }

  lines.push(
    `💬 Комментарий: ${comment ? `"${comment.slice(0, 60)}${comment.length > 60 ? '…' : ''}"` : '○ нет'}`,
  );

  if (Boolean(session.advancedKeepWithTts)) {
    lines.push(`\n⚠️ Advanced: KEEP+TTS`);
  }

  return lines.join('\n');
};

export const advancedPanelText = (session: RenderSession): string => {
  const keepWithTts = Boolean(session.advancedKeepWithTts);
  const duckDb = session.customDuckDb ?? -18;
  return (
    '⚙️ <b>Advanced настройки</b>\n\n' +
    `<b>KEEP+TTS:</b> ${keepWithTts ? 'ВКЛ ✓' : 'ВЫКЛ'}\n` +
    `<i>Оставить оригинальный звук И добавить TTS поверх</i>\n\n` +
    `<b>Duck уровень:</b> ${duckDb} dB\n` +
    `<i>Насколько приглушить оригинал при политике Duck (от −40 до −3)</i>`
  );
};

export const autoPanelText = (session: RenderSession): string => {
  const autoPublish = Boolean(session.autoPublishYoutube);
  const preset = session.textCardPreset ?? 'default';
  const bgFixed = session.fixedBackgroundVideoKey;
  const musicFixed = session.fixedBackgroundMusicKey;

  const videoLabel = bgFixed
    ? `📌 ${path.basename(bgFixed)}`
    : '🎲 Случайное из библиотеки';
  const musicLabel = musicFixed
    ? `📌 ${path.basename(musicFixed)}`
    : '🎲 Случайная из библиотеки';

  return (
    '🎭 <b>Spanish Jokes Auto</b> — настройки\n\n' +
    `🎬 Фон: ${videoLabel}\n` +
    `🎵 Музыка: ${musicLabel}\n` +
    `🃏 Стиль карточки: ${preset}\n` +
    `📺 Авто-YouTube: ${autoPublish ? '✅ включён' : '○ выключен'}\n\n` +
    '<i>Всё остальное — анекдот, сборка видео — бот сделает автоматически.</i>'
  );
};
