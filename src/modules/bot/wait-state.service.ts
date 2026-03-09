import { Injectable } from '@nestjs/common';
import type { WaitState, WaitType } from './bot.types';

/**
 * Управляет состоянием ожидания текстового ввода от пользователя.
 * Хранит данные в памяти (per-process), что достаточно для одного инстанса бота.
 */
@Injectable()
export class WaitStateService {
  private readonly waiting = new Map<string, WaitState>();

  set(sessionId: string, state: WaitState): void {
    this.waiting.set(sessionId, state);
  }

  get(sessionId: string): WaitState | undefined {
    return this.waiting.get(sessionId);
  }

  delete(sessionId: string): void {
    this.waiting.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.waiting.has(sessionId);
  }
}
