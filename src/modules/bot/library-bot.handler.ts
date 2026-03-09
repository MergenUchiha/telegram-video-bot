import { Injectable, Logger } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { LibraryAdminService } from '../library/library-admin.service';
import { BackgroundLibraryService } from '../library/background-library.service';
import { MusicLibraryService } from '../library/music-library.service';
import { TelegramFilesService } from '../telegram-files/telegram-files.service';

type UploadMode = 'video' | 'music';

@Injectable()
export class LibraryBotHandler {
  private readonly logger = new Logger(LibraryBotHandler.name);
  private readonly awaiting = new Map<string, UploadMode>();

  constructor(
    private readonly admin: LibraryAdminService,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
    private readonly tgFiles: TelegramFilesService,
  ) {}

  register(bot: Bot) {
    bot.command('library', async (ctx) => {
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId))
        return ctx.reply('🔒 Команда доступна только администратору.');

      this.awaiting.delete(userId);

      const arg = (ctx.message?.text ?? '')
        .split(' ')
        .slice(1)
        .join(' ')
        .trim();

      if (arg.startsWith('del_video ')) {
        const n = parseInt(arg.replace('del_video ', ''), 10);
        if (isNaN(n))
          return ctx.reply('❌ Укажи номер: /library del_video <N>');
        return ctx.reply(await this.admin.deleteVideo(n));
      }

      if (arg.startsWith('del_music ')) {
        const n = parseInt(arg.replace('del_music ', ''), 10);
        if (isNaN(n))
          return ctx.reply('❌ Укажи номер: /library del_music <N>');
        return ctx.reply(await this.admin.deleteTrack(n));
      }

      if (arg === 'help') return ctx.reply(LibraryAdminService.helpText());

      const status = await this.admin.getStatus();
      await ctx.reply(status, { reply_markup: this.mainKeyboard() });
    });

    bot.callbackQuery('lib:refresh', async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return;
      const status = await this.admin.getStatus();
      const msgId = ctx.callbackQuery.message?.message_id;
      try {
        await ctx.api.editMessageText(String(ctx.chat?.id), msgId!, status, {
          reply_markup: this.mainKeyboard(),
        });
      } catch {
        await ctx.reply(status, { reply_markup: this.mainKeyboard() });
      }
    });

    bot.callbackQuery('lib:upload_video', async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return;
      this.awaiting.set(userId, 'video');
      await ctx.reply(
        '🎬 Отправь фоновое видео.\n\n' +
          '💡 Лучше через 📎 → Файл — тогда Telegram не сожмёт качество.\n\n' +
          'Для отмены: /library',
      );
    });

    bot.callbackQuery('lib:upload_music', async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return;
      this.awaiting.set(userId, 'music');
      await ctx.reply(
        '🎵 Отправь аудиофайл для библиотеки.\n\n' +
          'Форматы: mp3, ogg, wav, aac, m4a, flac\n' +
          '💡 Отправляй через 📎 → Файл\n\n' +
          'Для отмены: /library',
      );
    });

    bot.callbackQuery('lib:del_video_prompt', async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return;
      const videos = await this.bgLibrary.listVideos();
      if (!videos.length) return ctx.reply('🎬 Видеотека пуста.');
      const kb = new InlineKeyboard();
      for (const v of videos) {
        kb.text(
          `🗑 ${v.index}. ${v.filename.slice(0, 30)}`,
          `lib:dv:${v.index}`,
        ).row();
      }
      kb.text('Отмена', 'lib:cancel_del');
      await ctx.reply('Выбери видео для удаления:', { reply_markup: kb });
    });

    bot.callbackQuery('lib:del_music_prompt', async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return;
      const tracks = await this.musicLibrary.listTracks();
      if (!tracks.length) return ctx.reply('🎵 Музыкальная библиотека пуста.');
      const kb = new InlineKeyboard();
      for (const t of tracks) {
        kb.text(
          `🗑 ${t.index}. ${t.filename.slice(0, 30)}`,
          `lib:dm:${t.index}`,
        ).row();
      }
      kb.text('Отмена', 'lib:cancel_del');
      await ctx.reply('Выбери трек для удаления:', { reply_markup: kb });
    });

    bot.callbackQuery('lib:cancel_del', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      try {
        await ctx.deleteMessage();
      } catch {}
    });

    bot.callbackQuery(/^lib:dv:(\d+)$/, async (ctx) => {
      const n = parseInt(ctx.match[1], 10);
      const result = await this.admin.deleteVideo(n);
      await ctx.answerCallbackQuery({ text: result });
      try {
        await ctx.deleteMessage();
      } catch {}
      await ctx.reply(result);
    });

    bot.callbackQuery(/^lib:dm:(\d+)$/, async (ctx) => {
      const n = parseInt(ctx.match[1], 10);
      const result = await this.admin.deleteTrack(n);
      await ctx.answerCallbackQuery({ text: result });
      try {
        await ctx.deleteMessage();
      } catch {}
      await ctx.reply(result);
    });

    bot.callbackQuery('lib:help', async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(LibraryAdminService.helpText());
    });

    // ВАЖНО: все три обработчика принимают `next` и пробрасывают его,
    // если сообщение не предназначено для библиотечного загрузчика.
    // Без этого Grammy останавливает цепочку и основной обработчик бота не получает видео.

    bot.on('message:document', async (ctx, next) => {
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return next();
      const mode = this.awaiting.get(userId);
      if (!mode) return next();

      const doc = ctx.message.document;
      const mime = doc.mime_type ?? '';
      const filename = doc.file_name ?? `file_${Date.now()}`;

      if (mode === 'video' && !mime.startsWith('video/')) {
        return ctx.reply(
          `❌ Ожидается видео-файл (получен: ${mime})\nОтправь снова или /library для отмены.`,
        );
      }
      if (
        mode === 'music' &&
        !this.isAudioMime(mime) &&
        !this.isAudioFilename(filename)
      ) {
        return ctx.reply(
          `❌ Ожидается аудиофайл (получен: ${mime || filename})\nФорматы: mp3, ogg, wav, aac, m4a, flac`,
        );
      }

      this.awaiting.delete(userId);
      await this.handleUpload(ctx, mode, doc.file_id, filename, doc.file_size);
    });

    bot.on('message:audio', async (ctx, next) => {
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return next();
      const mode = this.awaiting.get(userId);
      if (mode !== 'music') return next();

      this.awaiting.delete(userId);
      const audio = ctx.message.audio;
      const filename = audio.file_name ?? `audio_${Date.now()}.mp3`;
      await this.handleUpload(
        ctx,
        'music',
        audio.file_id,
        filename,
        audio.file_size,
      );
    });

    bot.on('message:video', async (ctx, next) => {
      const userId = String(ctx.from?.id);
      if (!this.admin.isAdmin(userId)) return next();
      const mode = this.awaiting.get(userId);
      if (mode !== 'video') return next();

      this.awaiting.delete(userId);
      await ctx.reply(
        '⚠️ Telegram сжал видео. Для оригинального качества: 📎 → Файл.\n⬇️ Загружаю...',
      );
      await this.handleUpload(
        ctx,
        'video',
        ctx.message.video.file_id,
        `video_${Date.now()}.mp4`,
        ctx.message.video.file_size,
      );
    });
  }

  private mainKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('🎬 Загрузить видео', 'lib:upload_video')
      .row()
      .text('🎵 Загрузить музыку', 'lib:upload_music')
      .row()
      .text('🗑 Удалить видео', 'lib:del_video_prompt')
      .text('🗑 Удалить трек', 'lib:del_music_prompt')
      .row()
      .text('🔄 Обновить', 'lib:refresh')
      .text('❓ Помощь', 'lib:help');
  }

  private async handleUpload(
    ctx: any,
    mode: UploadMode,
    fileId: string,
    filename: string,
    fileSize?: number,
  ): Promise<void> {
    const emoji = mode === 'video' ? '🎬' : '🎵';
    const uploadMsg = await ctx.reply(`⬇️ Загружаю ${emoji} в библиотеку...`);

    try {
      const { stream } = await this.tgFiles.downloadFileStream(fileId);
      let key: string;
      let total: number;

      if (mode === 'video') {
        key = await this.bgLibrary.uploadVideo(stream, filename, fileSize);
        total = await this.bgLibrary.count();
      } else {
        key = await this.musicLibrary.uploadTrack(stream, filename, fileSize);
        total = await this.musicLibrary.count();
      }

      const name = key.split('/').pop();
      const label = mode === 'video' ? 'Видеотека' : 'Музыкальная библиотека';

      await ctx.api.editMessageText(
        String(ctx.chat?.id),
        uploadMsg.message_id,
        `✅ ${emoji} Файл добавлен!\n\n📁 ${name}\n${label}: ${total} файлов`,
      );
    } catch (e: any) {
      this.logger.error(`Library ${mode} upload failed: ${e?.message}`);
      try {
        await ctx.api.editMessageText(
          String(ctx.chat?.id),
          uploadMsg.message_id,
          `❌ Ошибка загрузки: ${String(e?.message).slice(0, 300)}`,
        );
      } catch {
        await ctx.reply(`❌ Ошибка: ${String(e?.message).slice(0, 300)}`);
      }
    }
  }

  private isAudioMime(mime: string): boolean {
    return mime.startsWith('audio/');
  }

  private isAudioFilename(filename: string): boolean {
    return /\.(mp3|ogg|wav|aac|m4a|flac)$/i.test(filename);
  }
}
