import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execa } from 'execa';

export type MediaProbeResult = {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
};

@Injectable()
export class MediaProbeService {
  constructor(private readonly config: ConfigService) {}

  private ffprobePath() {
    return this.config.get<string>('FFPROBE_PATH') || 'ffprobe';
  }

  async probe(filePath: string): Promise<MediaProbeResult> {
    const ffprobe = this.ffprobePath();

    // JSON output
    const { stdout } = await execa(ffprobe, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]);

    const data = JSON.parse(stdout);
    const streams: any[] = data.streams || [];
    const format: any = data.format || {};

    const v = streams.find((s) => s.codec_type === 'video');
    if (!v) throw new Error('ffprobe: no video stream');

    const a = streams.find((s) => s.codec_type === 'audio');

    const width = Number(v.width || 0);
    const height = Number(v.height || 0);

    const durationSec = Number(format.duration || v.duration || 0) || 0;

    const fpsRaw = v.avg_frame_rate || v.r_frame_rate || '0/0';
    const fps = this.parseFps(fpsRaw);

    return {
      width,
      height,
      durationSec,
      fps: fps > 0 ? fps : 30,
      hasAudio: Boolean(a),
    };
  }

  private parseFps(rate: string): number {
    // "30000/1001"
    const m = String(rate).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) return Number(rate) || 0;
    const n = Number(m[1]);
    const d = Number(m[2]);
    if (!d) return 0;
    return n / d;
  }
}
