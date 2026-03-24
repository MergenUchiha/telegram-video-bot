/** Payload для задачи YouTube-загрузки в BullMQ */
export interface YouTubeUploadPayload {
  sessionId: string;
  channelId: string; // YoutubeChannel.id (UUID)
  chatId: string;
  userId: string;
}

/** Метаданные видео для YouTube-загрузки */
export interface YouTubeVideoMeta {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'public' | 'unlisted' | 'private';
}
