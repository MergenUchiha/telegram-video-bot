import { InlineKeyboard } from 'grammy';
import type { RenderSession } from '@prisma/client';
import { AUDIO_POLICIES } from '../bot.constants';

export const mainMenuKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('🎭 Spanish Jokes Auto', 'menu:jokes')
    .row()
    .text('🎬 Стандартный рендер', 'menu:standard');

export const standardPanelKeyboard = (
  session: RenderSession,
): InlineKeyboard => {
  const tts = Boolean(session.ttsEnabled);
  const subs = session.subtitlesMode ?? 'NONE';
  const audio = session.originalAudioPolicy ?? 'DUCK';
  const hasVideo = Boolean(session.sourceVideoKey);

  const mark = (cond: boolean) => (cond ? ' ✓' : '');
  const kb = new InlineKeyboard();

  if (!hasVideo) {
    kb.text('🏠 Главное меню', 'menu:back');
    return kb;
  }

  kb.text(`🗣 TTS: ${tts ? 'ВКЛ ✓' : 'ВЫКЛ'}`, 's:tts_toggle').row();

  if (tts) {
    kb.text('✍️ Текст для TTS', 's:tts_text').row();
    kb.text('🌐 Язык', 's:language')
      .text('🎙 Голос', 's:voice')
      .text('⚡ Скорость', 's:speed')
      .row();
    kb.text(
      `📝 Субтитры: ${subs}${mark(subs === 'HARD')}`,
      's:subs_toggle',
    ).row();
  }

  kb.text('💬 Комментарий', 's:comment').row();

  kb.text(`Replace${mark(audio === 'REPLACE')}`, 's:audio:REPLACE')
    .text(`Duck${mark(audio === 'DUCK')}`, 's:audio:DUCK')
    .row();
  kb.text(`Mute${mark(audio === 'MUTE')}`, 's:audio:MUTE')
    .text(`Keep${mark(audio === 'KEEP')}`, 's:audio:KEEP')
    .row();

  kb.text('⚙️ Advanced', 's:advanced').row();
  kb.text('▶️ Рендерить!', 'do:approve').row();
  kb.text('🏠 Главное меню', 'menu:back');
  return kb;
};

export const advancedKeyboard = (session: RenderSession): InlineKeyboard => {
  const keepWithTts = Boolean(session.advancedKeepWithTts);
  const duckDb = session.customDuckDb ?? -18;
  return new InlineKeyboard()
    .text(`KEEP+TTS: ${keepWithTts ? 'ВКЛ ✓' : 'ВЫКЛ'}`, 'adv:keep_tts')
    .row()
    .text(`Duck: ${duckDb} dB — изменить`, 'adv:duck_level')
    .row()
    .text('← Назад', 'adv:back');
};

export const autoPanelKeyboard = (session: RenderSession): InlineKeyboard => {
  const autoPublish = Boolean(session.autoPublishYoutube);
  const bgFixed = session.fixedBackgroundVideoKey;
  const musicFixed = session.fixedBackgroundMusicKey;

  return new InlineKeyboard()
    .text(
      bgFixed ? '🎬 Фон: выбран ✓' : '🎬 Выбрать фоновое видео',
      'auto:pick_video',
    )
    .row()
    .text(
      musicFixed ? '🎵 Музыка: выбрана ✓' : '🎵 Выбрать музыку',
      'auto:pick_music',
    )
    .row()
    .text('🃏 Стиль карточки', 'auto:preset_cycle')
    .text('📊 Анекдоты', 'auto:jokes_status')
    .row()
    .text(
      autoPublish ? '📺 Авто-YouTube: ВКЛ ✓' : '📺 Авто-YouTube',
      'auto:toggle_youtube',
    )
    .row()
    .text('▶️ Запустить!', 'do:approve')
    .row()
    .text('🏠 Главное меню', 'menu:back');
};
