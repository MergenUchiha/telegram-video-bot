import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { YouTubeService } from './youtube.service';

@Controller('youtube')
export class YouTubeController {
  constructor(private readonly youtubeService: YouTubeService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    try {
      await this.youtubeService.addChannel(state, code);

      return res.send(`
        <html>
          <body>
            <h2>YouTube channel connected successfully</h2>
            <p>You can return to Telegram.</p>
          </body>
        </html>
      `);
    } catch (e) {
      return res.status(500).send(`
        <html>
          <body>
            <h2>Connection error</h2>
            <pre>${e instanceof Error ? e.message : String(e)}</pre>
          </body>
        </html>
      `);
    }
  }
}
