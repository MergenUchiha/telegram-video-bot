import { Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { LibraryAdminService } from '../library/library-admin.service';
import { AutonomyService } from './autonomy.service';
import { clipError, isValidDateOnly } from './autonomy.utils';

@Injectable()
export class AutonomyBotHandler {
  constructor(
    private readonly admin: LibraryAdminService,
    private readonly autonomy: AutonomyService,
  ) {}

  register(bot: Bot) {
    bot.command('autonomy', async (ctx) => {
      const telegramUserId = String(ctx.from?.id);
      if (!this.admin.isAdmin(telegramUserId)) {
        return ctx.reply('🔒 Команда доступна только администратору.');
      }

      const args = (ctx.message?.text ?? '').trim().split(/\s+/).slice(1);

      if (args[0] === 'on') {
        const pipeline = await this.autonomy.setPipelineEnabled(true);
        await this.autonomy
          .reconcile(this.autonomy.pipelineKey())
          .catch(() => {});
        return ctx.reply(
          `✅ Autonomy enabled.\nRuntime env flag: ${this.autonomy.runtimeEnabledFlag() ? 'on' : 'off'}\nPipeline: ${pipeline?.key}`,
        );
      }

      if (args[0] === 'off') {
        const pipeline = await this.autonomy.setPipelineEnabled(false);
        return ctx.reply(`🛑 Autonomy disabled.\nPipeline: ${pipeline?.key}`);
      }

      if (args[0] === 'plan') {
        const planDate = args[1];
        const count = Number(args[2]);
        if (!planDate || !isValidDateOnly(planDate)) {
          return ctx.reply('❌ Usage: /autonomy plan YYYY-MM-DD <count>');
        }
        if (!Number.isInteger(count)) {
          return ctx.reply('❌ Count must be an integer.');
        }

        try {
          await this.autonomy.applyDayOverride(planDate, count, telegramUserId);
          return ctx.reply(
            `✅ Override saved for ${planDate}: ${count} videos.`,
          );
        } catch (error) {
          return ctx.reply(`❌ ${clipError(error, 500)}`);
        }
      }

      if (args[0] === 'rerun') {
        const runId = args[1];
        if (!runId) return ctx.reply('❌ Usage: /autonomy rerun <runId>');

        try {
          const run = await this.autonomy.rerunFailedRun(runId);
          return ctx.reply(`✅ Run requeued: ${run?.id}`);
        } catch (error) {
          return ctx.reply(`❌ ${clipError(error, 500)}`);
        }
      }

      const status = await this.autonomy.getTodayStatus();
      await ctx.reply(this.autonomy.buildStatusMessage(status));
    });
  }
}
