import { YoutubeMetadataService } from './youtube-metadata.service';

describe('YoutubeMetadataService', () => {
  const service = new YoutubeMetadataService();

  it('builds deterministic title and description from joke text', () => {
    const metadata = service.build({
      jokeText:
        '¿Por qué el libro de matemáticas estaba triste?\n\nPorque tenía demasiados problemas.',
      jokeSourceUrl: 'https://example.com/joke',
      titleSuffix: '#shorts',
      descriptionFooter: 'Daily Spanish jokes.',
    });

    expect(metadata.title).toContain('#shorts');
    expect(metadata.title.startsWith('¿Por qué el libro')).toBe(true);
    expect(metadata.description).toContain(
      'Porque tenía demasiados problemas.',
    );
    expect(metadata.description).toContain('Source: https://example.com/joke');
    expect(metadata.description).toContain('Daily Spanish jokes.');
  });

  it('truncates long titles to the requested max length budget', () => {
    const title = service.buildTitle(
      'Una linea extremadamente larga que sigue y sigue hasta sobrepasar cualquier limite razonable para un titulo de YouTube Shorts',
      '#shorts',
      40,
    );

    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith('#shorts')).toBe(true);
  });
});
