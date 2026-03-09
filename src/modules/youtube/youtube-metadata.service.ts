import { Injectable } from '@nestjs/common';

export interface YoutubeMetadataInput {
  jokeText: string;
  jokeSourceUrl?: string | null;
  titleSuffix: string;
  descriptionFooter?: string | null;
}

export interface YoutubeVideoMetadata {
  title: string;
  description: string;
}

@Injectable()
export class YoutubeMetadataService {
  build(input: YoutubeMetadataInput): YoutubeVideoMetadata {
    return {
      title: this.buildTitle(input.jokeText, input.titleSuffix),
      description: this.buildDescription(
        input.jokeText,
        input.jokeSourceUrl,
        input.descriptionFooter,
      ),
    };
  }

  buildTitle(jokeText: string, suffix: string, maxLength = 85): string {
    const safeSuffix = (suffix || '#shorts').trim() || '#shorts';
    const firstLine =
      jokeText
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .find(Boolean) || 'Chiste del dia';

    const suffixPart = safeSuffix ? ` ${safeSuffix}` : '';
    const room = Math.max(1, maxLength - suffixPart.length);
    const base =
      firstLine.length > room
        ? `${firstLine.slice(0, room - 1).trim()}…`
        : firstLine;

    return `${base}${suffixPart}`.trim();
  }

  buildDescription(
    jokeText: string,
    jokeSourceUrl?: string | null,
    descriptionFooter?: string | null,
  ): string {
    const blocks = [jokeText.trim()];

    if (jokeSourceUrl) {
      blocks.push(`Source: ${jokeSourceUrl.trim()}`);
    }

    if (descriptionFooter?.trim()) {
      blocks.push(descriptionFooter.trim());
    }

    return blocks.filter(Boolean).join('\n\n');
  }
}
