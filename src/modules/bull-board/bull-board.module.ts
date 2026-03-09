import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { QUEUE_RENDER } from '../redis/redis.constants';

/**
 * Монтирует Bull Board UI по маршруту /admin/queues.
 *
 * Защита: Authorization: Bearer <BULL_BOARD_TOKEN>
 * Если BULL_BOARD_TOKEN не задан — открыт (только для dev).
 *
 * Установка пакетов:
 *   npm install @bull-board/api @bull-board/nestjs @bull-board/express
 */
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: QUEUE_RENDER,
      adapter: BullMQAdapter,
    }),
  ],
})
export class BullBoardAppModule implements NestModule {
  constructor(private readonly config: ConfigService) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        const token = this.config.get<string>('BULL_BOARD_TOKEN');
        if (!token) return next(); // dev: открыт

        const auth = req.headers['authorization'] ?? '';
        const provided = auth.replace(/^Bearer\s+/i, '').trim();

        if (provided !== token) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        return next();
      })
      .forRoutes({ path: '/admin/queues*', method: RequestMethod.ALL });
  }
}
