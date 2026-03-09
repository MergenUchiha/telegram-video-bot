/** Payload для задачи рендера в BullMQ */
export interface RenderJobPayload {
  sessionId: string;
  userId: string;
  chatId: string;
}
