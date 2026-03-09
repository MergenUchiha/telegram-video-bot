import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { randomUUID } from 'node:crypto';
import { ContentMode, RenderSessionState } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { StorageService } from '../../storage/storage.service';
import { TelegramFilesService } from '../../telegram-files/telegram-files.service';
import { BotContextHelper } from '../bot-context.helper';
import { WaitStateService } from '../../redis/wait-state/wait-state.service';
import { RateLimitService } from '../rate-limit.service';
import { standardPanelText } from '../panels/index';
import { standardPanelKeyboard } from '../keyboards/index';

const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB

@Injectable()
export class VideoUploadHandler {
  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly tgFiles: TelegramFilesService,
    private readonly helper: BotContextHelper,
    private readonly waitState: WaitStateService,
    private readonly rateLimit: RateLimitService,
  ) {}

  register(bot: Bot): void {
    bot.on('message:video', async (ctx, next) => {
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) {
        await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
        await ctx.reply('Нажми /start, чтобы выбрать режим.', {
          parse_mode: 'HTML',
        });
        return;
      }

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
        await ctx.reply(
          '⏳ Рендер выполняется. Отправь видео после завершения.',
        );
        return;
      }

      if (session.contentMode === ContentMode.SPANISH_JOKES_AUTO) {
        await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
        return;
      }

      // Rate limit на загрузку видео
      const rl = await this.rateLimit.check(String(ctx.from?.id), 'upload');
      if (!rl.allowed) {
        await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
        await ctx.reply(
          `⏳ Слишком много загрузок. Попробуй через ${Math.ceil(rl.resetInSec / 60)} мин.\n` +
            `Лимит: 5 видео в час.`,
        );
        return;
      }

      // Проверка размера до скачивания
      const fileSize = ctx.message.video.file_size;
      if (fileSize && fileSize > MAX_VIDEO_SIZE_BYTES) {
        await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
        const sizeMb = Math.round(fileSize / 1024 / 1024);
        await ctx.reply(
          `❌ Файл слишком большой: ${sizeMb} МБ.\n` +
            `Максимальный размер: 200 МБ.\n\n` +
            `Сожми видео перед отправкой или обрежь лишнее.`,
        );
        return;
      }

      await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);
      await this.handleVideoUpload(ctx, session);
    });
  }

  private async handleVideoUpload(ctx: any, session: any): Promise<void> {
    const panelMsgId = session.lastBotMessageId as number | null;

    if (panelMsgId) {
      await this.helper.editPanel(
        ctx,
        panelMsgId,
        '⬇️ <b>Загружаю видео...</b>',
        new InlineKeyboard(),
      );
    }

    try {
      await this.storage.ensureBucketExists();

      const { stream, filePath } = await this.tgFiles.downloadFileStream(
        ctx.message.video.file_id,
      );
      const ext = filePath.includes('.') ? filePath.split('.').pop() : 'mp4';
      const key = `inputs/${session.id}/${randomUUID()}.${ext}`;

      await this.storage.uploadStream(
        key,
        stream,
        'video/mp4',
        ctx.message.video.file_size,
      );
      await this.sessions.setTelegramMeta(session.id, {
        videoFileId: ctx.message.video.file_id,
        tgFilePath: filePath,
      });
      await this.sessions.setSourceVideoKey(session.id, key);
      await this.sessions.setOverlayComment(session.id, null);
      await this.sessions.setState(
        session.id,
        RenderSessionState.WAIT_TEXT_OR_SETTINGS,
      );

      const fresh = await this.sessions.getSessionById(session.id);
      const text = standardPanelText(fresh!);
      const kb = standardPanelKeyboard(fresh!);

      if (panelMsgId) {
        const newId = await this.helper.editPanel(ctx, panelMsgId, text, kb);
        if (newId !== panelMsgId) {
          await this.sessions.setLastBotMessageId(session.id, newId);
        }
      } else {
        await this.helper.sendPanel(ctx, session.id, text, kb);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const errText = `❌ <b>Ошибка загрузки видео</b>\n\n${msg.slice(0, 400)}`;

      if (panelMsgId) {
        await this.helper.editPanel(
          ctx,
          panelMsgId,
          errText,
          new InlineKeyboard().text('🏠 Главное меню', 'menu:back'),
        );
      } else {
        await ctx.reply(errText, { parse_mode: 'HTML' });
      }
    }
  }
}
