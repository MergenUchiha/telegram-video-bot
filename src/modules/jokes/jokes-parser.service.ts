import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface JokeSource {
  name: string;
  pageUrl: (page: number) => string;
  maxPages: number;
  selectors: { pattern: RegExp; group: number }[];
}

@Injectable()
export class JokesParserService {
  private readonly logger = new Logger(JokesParserService.name);

  private static readonly FALLBACK_JOKES: string[] = [
    '¿Por qué el libro de matemáticas estaba triste?\n\nPorque tenía demasiados problemas.',
    '¿Qué le dice un semáforo a otro?\n\n¡No me mires que me estoy cambiando!',
    '¿Por qué los esqueletos no pueden tocar la guitarra?\n\nPorque no tienen el nervio.',
    '¿Qué hace una abeja en el gimnasio?\n\n¡Zum-ba!',
    '¿Por qué el fantasma no mentía nunca?\n\nPorque se le notaba en la cara.',
    '¿Cómo se llama el campeón de buceo de México?\n\nManuel... ¡Manuel! ¡Manuel!',
    '¿Por qué el sol no va a la universidad?\n\nPorque ya tiene millones de grados.',
    '¿Qué le dijo el océano a la playa?\n\nNada, solo la saludó con una ola.',
    '¿Por qué los pájaros vuelan hacia el sur en invierno?\n\nPorque si fueran caminando, tardarían demasiado.',
    '¿Qué hace un pez cuando se aburre?\n\nNada.',
    '¿Por qué el espantapájaros ganó un premio?\n\nPorque era sobresaliente en su campo.',
    '¿Cómo se dice piscina en japonés?\n\nQue-salten-ya.',
    '¿Qué animal necesita aceite?\n\nLa serpi-ente.',
    '¿Por qué Peter Pan siempre vuela?\n\nPorque si caminara, llegaría a nunca-más.',
    '¿Qué le dice una iguana a su hermana gemela?\n\nSomos iguanas.',
    '¿Por qué Drácula no tiene amigos?\n\nPorque es un tipo que muerde.',
    '¿Qué le dijo el cero al ocho?\n\n¡Bonito cinturón!',
    '¿Cuál es el animal más antiguo?\n\nEl lagarto — porque el que la sigue, la consigue.',
    '¿Por qué los elefantes no usan ordenadores?\n\nPorque le tienen miedo al ratón.',
    '¿Qué hace un pirata en el ordenador?\n\nBusca el cursor.',
  ];

  private readonly SOURCES: JokeSource[] = [
    {
      name: 'chistes.com',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chistes.com/categoria/chistes-cortos/'
          : `https://www.chistes.com/categoria/chistes-cortos/page/${p}/`,
      maxPages: 4,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste-content|joke-text|entry-content|post-content|chiste|content-chiste)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        { pattern: /<article[^>]*>([\s\S]*?)<\/article>/gi, group: 1 },
      ],
    },
    {
      name: 'reir.es',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.reir.es/chistes-cortos/'
          : `https://www.reir.es/chistes-cortos/page/${p}/`,
      maxPages: 4,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste|joke|texto|content|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        { pattern: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, group: 1 },
      ],
    },
    {
      name: 'chispazo.net',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chispazo.net/chistes-cortos/'
          : `https://www.chispazo.net/chistes-cortos/page/${p}/`,
      maxPages: 3,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:joke|chiste|humor|post-body|entry-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'verdesymalos.com',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.verdesymalos.com/chistes-cortos/'
          : `https://www.verdesymalos.com/chistes-cortos/?page=${p}`,
      maxPages: 3,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste-texto|joke-body|content|texto)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<p[^>]*class="[^"]*(?:chiste|joke|texto)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'chistalia.es',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chistalia.es/cortos/'
          : `https://www.chistalia.es/cortos/page/${p}/`,
      maxPages: 5,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<div[^>]*class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'cuentameunchiste.com',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.cuentameunchiste.com/chistes-cortos/'
          : `https://www.cuentameunchiste.com/chistes-cortos/page/${p}/`,
      maxPages: 5,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:post-content|entry-content|chiste-content|joke-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<div[^>]*class="[^"]*(?:td-post-content|tdb-block-inner)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'chistes.net',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chistes.net/ChistesCortos.aspx'
          : `https://www.chistes.net/ChistesCortos.aspx?pagina=${p}`,
      maxPages: 5,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:texto-chiste|chiste-item|joke-item|chiste)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<td[^>]*class="[^"]*(?:fondo2|texto|chiste)[^"]*"[^>]*>([\s\S]*?)<\/td>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'geniol.es',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.geniol.es/humor/chistes/cortos/'
          : `https://www.geniol.es/humor/chistes/cortos/page/${p}/`,
      maxPages: 5,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:entry-content|post-content|chiste-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<article[^>]*class="[^"]*(?:post|chiste)[^"]*"[^>]*>([\s\S]*?)<\/article>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'es.chistes.cc',
      pageUrl: (p) =>
        p === 1
          ? 'https://es.chistes.cc/chistes-cortos/'
          : `https://es.chistes.cc/chistes-cortos/${p}/`,
      maxPages: 6,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:joke|chiste|texto|content-joke)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
      ],
    },
  ];

  constructor(private readonly config: ConfigService) {}

  async fetchJokes(): Promise<string[]> {
    const pagesPerSource = Number(
      this.config.get<string>('JOKES_PAGES_PER_SOURCE', '3'),
    );
    const enabledRaw = (
      this.config.get<string>('JOKES_SOURCES_ENABLED', '') ?? ''
    )
      .replace(/^["']|["']$/g, '')
      .trim();

    let activeSources = this.SOURCES;

    if (enabledRaw) {
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/\/$/, '');
      const requested = enabledRaw.split(',').map((s) => normalize(s.trim()));
      const filtered = this.SOURCES.filter((src) =>
        requested.some(
          (req) =>
            normalize(src.name).startsWith(req) ||
            req.startsWith(normalize(src.name)),
        ),
      );
      if (filtered.length === 0) {
        this.logger.warn(
          `JOKES_SOURCES_ENABLED="${enabledRaw}" matched no sources. Using all.`,
        );
      } else {
        activeSources = filtered;
        this.logger.log(
          `Active sources: ${filtered.map((s) => s.name).join(', ')}`,
        );
      }
    }

    this.logger.log(
      `Fetching from ${activeSources.length} sources, up to ${pagesPerSource} pages each...`,
    );

    const results = await Promise.allSettled(
      activeSources.map((src) => this.fetchFromSource(src, pagesPerSource)),
    );

    const allJokes: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        this.logger.log(`✅ ${activeSources[i].name}: ${r.value.length} jokes`);
        allJokes.push(...r.value);
      } else {
        this.logger.warn(
          `❌ ${activeSources[i].name}: ${r.reason?.message ?? r.reason}`,
        );
      }
    }

    const unique = this.deduplicate(allJokes);
    this.logger.log(`Total: ${allJokes.length} raw → ${unique.length} unique`);

    if (unique.length < 10) {
      this.logger.warn(
        `Only ${unique.length} jokes from web, merging with fallbacks`,
      );
      return this.shuffle(
        this.deduplicate([...unique, ...JokesParserService.FALLBACK_JOKES]),
      );
    }

    return this.shuffle(unique);
  }

  private async fetchFromSource(
    source: JokeSource,
    maxPages: number,
  ): Promise<string[]> {
    const limit = Math.min(maxPages, source.maxPages);
    const collected: string[] = [];
    const collectedKeys = new Set<string>();
    let emptyStreak = 0;

    for (let page = 1; page <= limit; page++) {
      const url = source.pageUrl(page);
      try {
        const html = await this.fetchHtml(url);
        const found = this.extractFromHtml(html, source.selectors);

        if (found.length === 0) {
          this.logger.debug(`${source.name} p${page}: no jokes, stopping`);
          break;
        }

        const newOnes = found.filter(
          (j) => !collectedKeys.has(this.normalizeKey(j)),
        );
        if (newOnes.length === 0) {
          emptyStreak++;
          if (emptyStreak >= 2) break;
          continue;
        }

        emptyStreak = 0;
        for (const j of newOnes) {
          collected.push(j);
          collectedKeys.add(this.normalizeKey(j));
        }
        this.logger.debug(`${source.name} p${page}: +${newOnes.length}`);
      } catch (e: any) {
        this.logger.warn(`${source.name} p${page} error: ${e?.message}`);
        break;
      }
    }

    return collected;
  }

  private normalizeKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  private async fetchHtml(url: string): Promise<string> {
    const timeout = Number(
      this.config.get<string>('JOKES_FETCH_TIMEOUT_MS', '10000'),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private extractFromHtml(
    html: string,
    selectors: { pattern: RegExp; group: number }[],
  ): string[] {
    const min = Number(this.config.get<string>('JOKES_MIN_LENGTH', '40'));
    const max = Number(this.config.get<string>('JOKES_MAX_LENGTH', '600'));
    const jokes: string[] = [];

    for (const sel of selectors) {
      sel.pattern.lastIndex = 0;
      for (const m of html.matchAll(sel.pattern)) {
        const text = this.cleanHtml(m[sel.group] ?? '');
        if (
          text.length >= min &&
          text.length <= max &&
          this.looksSpanish(text) &&
          !this.isGarbage(text) &&
          !jokes.includes(text)
        ) {
          jokes.push(text);
        }
      }
      if (jokes.length >= 5) break;
    }

    if (jokes.length < 5) {
      for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
        const text = this.cleanHtml(m[1] ?? '');
        if (
          text.length >= min &&
          text.length <= max &&
          this.looksSpanish(text) &&
          !this.isGarbage(text) &&
          !jokes.includes(text)
        ) {
          jokes.push(text);
        }
      }
    }

    return jokes;
  }

  private deduplicate(jokes: string[]): string[] {
    const seen = new Map<string, string>();
    for (const joke of jokes) {
      const key = this.normalizeKey(joke);
      if (!seen.has(key)) seen.set(key, joke);
    }
    return Array.from(seen.values());
  }

  private cleanHtml(raw: string): string {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/blockquote>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&aacute;/gi, 'á')
      .replace(/&eacute;/gi, 'é')
      .replace(/&iacute;/gi, 'í')
      .replace(/&oacute;/gi, 'ó')
      .replace(/&uacute;/gi, 'ú')
      .replace(/&ntilde;/gi, 'ñ')
      .replace(/&iquest;/gi, '¿')
      .replace(/&iexcl;/gi, '¡')
      .replace(/&uuml;/gi, 'ü')
      .replace(/&#\d+;/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ \n/g, '\n')
      .replace(/\n /g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private looksSpanish(text: string): boolean {
    return (
      /[áéíóúñ¿¡üÁÉÍÓÚÑÜ]/.test(text) ||
      /\b(que|por|qué|una|este|esto|cuando|como|cómo|porque|tiene|dice|hace|para)\b/i.test(
        text,
      )
    );
  }

  private isGarbage(text: string): boolean {
    const siteMetaPatterns = [
      /está concebido únicamente/i,
      /nuestra selección de chistes/i,
      /política de privacidad/i,
      /todos los derechos reservados/i,
      /aviso legal/i,
      /términos (de uso|y condiciones)/i,
      /síguenos en/i,
      /comparte (este|en)/i,
      /haz clic (aquí|para)/i,
      /suscríbete/i,
      /newsletter/i,
      /publicidad/i,
      /categorías/i,
      /inicio\s*$/i,
      /siguiente página/i,
      /ver más chistes/i,
    ];
    if (siteMetaPatterns.some((p) => p.test(text))) return true;
    if (/https?:\/\//.test(text)) return true;
    if (/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return true;
    if (/©|copyright/i.test(text)) return true;
    if (!/[.!?]/.test(text)) return true;

    const words = text.split(/\s+/);
    if (words.length < 5) return true;
    const capsWords = words.filter(
      (w) =>
        w.length > 2 &&
        w[0] === w[0].toUpperCase() &&
        w[0] !== w[0].toLowerCase(),
    );
    if (capsWords.length / words.length > 0.6) return true;

    return false;
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
