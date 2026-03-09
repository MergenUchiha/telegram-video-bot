import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Конфигурация одного источника анекдотов.
 */
interface JokeSource {
  name: string;
  /** Формирует URL страницы N (1-based) */
  pageUrl: (page: number) => string;
  /** Макс. страниц для парсинга с этого источника */
  maxPages: number;
  /** CSS-подобные паттерны для извлечения текста (специфичны для каждого сайта) */
  selectors: SourceSelector[];
}

interface SourceSelector {
  /** Regex для поиска HTML-блоков */
  pattern: RegExp;
  /** Индекс capture-группы с текстом */
  group: number;
}

@Injectable()
export class JokesParserService {
  private readonly logger = new Logger(JokesParserService.name);

  // ── Встроенные запасные анекдоты ──────────────────────────────────────
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

  // ── Определения источников ─────────────────────────────────────────────
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
        {
          pattern: /<article[^>]*>([\s\S]*?)<\/article>/gi,
          group: 1,
        },
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
        {
          pattern: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
          group: 1,
        },
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
    // ── Дополнительные источники ──────────────────────────────────────────
    {
      name: 'chistalia.es',
      // WordPress: каждый анекдот в отдельном <article class="post">
      // Берём параграфы внутри .entry-content — там сам текст
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chistalia.es/cortos/'
          : `https://www.chistalia.es/cortos/page/${p}/`,
      maxPages: 5,
      selectors: [
        // Точный: только текст внутри entry-content (не весь article)
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
      // WordPress: анекдот внутри .post-content или .entry-content
      // НЕ берём весь <article> — там есть мета-описание сайта в header
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
          ? 'https://www.chistes.net/chistes-cortos/'
          : `https://www.chistes.net/chistes-cortos/pag${p}.asp`,
      maxPages: 5,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste|texto|joke)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern:
            /<td[^>]*class="[^"]*(?:chiste|texto|joke|contenido)[^"]*"[^>]*>([\s\S]*?)<\/td>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'mejoreschistes.com',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.mejoreschistes.com/chistes/cortos/'
          : `https://www.mejoreschistes.com/chistes/cortos/page/${p}/`,
      maxPages: 4,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste-texto|joke-text|entry-content|the-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
      ],
    },
    {
      name: 'chistesbuenos.net',
      pageUrl: (p) =>
        p === 1
          ? 'https://www.chistesbuenos.net/chistes-cortos'
          : `https://www.chistesbuenos.net/chistes-cortos/pagina/${p}`,
      maxPages: 4,
      selectors: [
        {
          pattern:
            /<div[^>]*class="[^"]*(?:chiste|texto-chiste|contenido|joke)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          group: 1,
        },
        {
          pattern: /<p[^>]*class="[^"]*chiste[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
          group: 1,
        },
      ],
    },
  ];

  constructor(private readonly config: ConfigService) {}

  // ── Публичное API ──────────────────────────────────────────────────────

  /**
   * Получить максимально большой пул анекдотов из всех источников.
   *
   * Алгоритм:
   *  1. Параллельно опрашиваем все источники (каждый — несколько страниц)
   *  2. Дедуплицируем по SHA-like нормализации текста
   *  3. Если пул < 10 — добавляем встроенные запасные
   *  4. Возвращаем перемешанный массив
   *
   * Env:
   *   JOKES_PAGES_PER_SOURCE  — страниц с каждого источника (default: 3)
   *   JOKES_MIN_LENGTH        — мин. длина текста (default: 40)
   *   JOKES_MAX_LENGTH        — макс. длина текста (default: 600)
   *   JOKES_FETCH_TIMEOUT_MS  — таймаут одной страницы мс (default: 10000)
   *   JOKES_SOURCES_ENABLED   — имена через запятую, пусто = все
   *                             пример: "chistes.com,reir.es"
   */
  async fetchJokes(): Promise<string[]> {
    const pagesPerSource = Number(
      this.config.get<string>('JOKES_PAGES_PER_SOURCE', '3'),
    );
    // Убираем кавычки (если пользователь написал JOKES_SOURCES_ENABLED="x,y")
    const enabledRaw = (
      this.config.get<string>('JOKES_SOURCES_ENABLED', '') ?? ''
    )
      .replace(/^["']|["']$/g, '')
      .trim();

    let activeSources = this.SOURCES;

    if (enabledRaw) {
      // Нормализуем: убираем http(s)://, www., trailing slash для сравнения
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/\/$/, '');

      const requestedNames = enabledRaw
        .split(',')
        .map((s) => normalize(s.trim()));
      const filtered = this.SOURCES.filter((src) =>
        requestedNames.some(
          (req) =>
            normalize(src.name).startsWith(req) ||
            req.startsWith(normalize(src.name)),
        ),
      );

      if (filtered.length === 0) {
        this.logger.warn(
          `JOKES_SOURCES_ENABLED="${enabledRaw}" — не совпало ни с одним источником. ` +
            `Доступные: ${this.SOURCES.map((s) => s.name).join(', ')}. ` +
            `Используем все источники.`,
        );
      } else {
        activeSources = filtered;
        this.logger.log(
          `JOKES_SOURCES_ENABLED: используем ${filtered.map((s) => s.name).join(', ')}`,
        );
      }
    }

    this.logger.log(
      `Fetching jokes from ${activeSources.length} sources, ` +
        `up to ${pagesPerSource} pages each...`,
    );

    // Параллельный запрос всех источников
    const results = await Promise.allSettled(
      activeSources.map((src) => this.fetchFromSource(src, pagesPerSource)),
    );

    const allJokes: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const srcName = activeSources[i].name;
      if (r.status === 'fulfilled') {
        this.logger.log(`✅ ${srcName}: ${r.value.length} jokes`);
        allJokes.push(...r.value);
      } else {
        this.logger.warn(`❌ ${srcName}: ${r.reason?.message ?? r.reason}`);
      }
    }

    // Дедупликация
    const unique = this.deduplicate(allJokes);
    this.logger.log(
      `Total: ${allJokes.length} raw → ${unique.length} unique jokes`,
    );

    // Добавляем fallback если мало
    if (unique.length < 10) {
      this.logger.warn(
        `Only ${unique.length} jokes from web, merging with ${JokesParserService.FALLBACK_JOKES.length} fallbacks`,
      );
      const merged = this.deduplicate([
        ...unique,
        ...JokesParserService.FALLBACK_JOKES,
      ]);
      return this.shuffle(merged);
    }

    return this.shuffle(unique);
  }

  // ── Приватные методы ──────────────────────────────────────────────────

  /**
   * Забрать анекдоты с одного источника — несколько страниц последовательно.
   * Останавливаемся если страница вернула 0 новых анекдотов (конец пагинации).
   */
  private async fetchFromSource(
    source: JokeSource,
    maxPages: number,
  ): Promise<string[]> {
    const limit = Math.min(maxPages, source.maxPages);
    const collected: string[] = [];
    // Нормализованные ключи для быстрой дедупликации
    const collectedKeys = new Set<string>();
    let emptyStreak = 0; // страниц подряд без новых анекдотов

    for (let page = 1; page <= limit; page++) {
      const url = source.pageUrl(page);
      try {
        const html = await this.fetchHtml(url);
        const found = this.extractFromHtml(html, source.selectors);

        if (found.length === 0) {
          this.logger.debug(
            `${source.name} p${page}: no jokes found, stopping`,
          );
          break;
        }

        const newOnes = found.filter((j) => {
          const k = this.normalizeKey(j);
          return !collectedKeys.has(k);
        });

        if (newOnes.length === 0) {
          emptyStreak++;
          this.logger.debug(
            `${source.name} p${page}: all ${found.length} duplicate (streak: ${emptyStreak})`,
          );
          // Останавливаемся после 2 пустых страниц подряд
          if (emptyStreak >= 2) break;
          continue;
        }

        emptyStreak = 0;
        for (const j of newOnes) {
          collected.push(j);
          collectedKeys.add(this.normalizeKey(j));
        }
        this.logger.debug(
          `${source.name} p${page}: +${newOnes.length} jokes (${found.length} parsed)`,
        );
      } catch (e: any) {
        this.logger.warn(`${source.name} p${page} error: ${e?.message}`);
        break;
      }
    }

    return collected;
  }

  /** Нормализованный ключ для дедупликации */
  private normalizeKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** HTTP запрос страницы */
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
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            'Chrome/121.0.0.0 Safari/537.36',
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

  /**
   * Извлечь анекдоты из HTML по набору селекторов источника.
   * Если специфичные селекторы дали мало — используем универсальный <p> fallback.
   */
  private extractFromHtml(html: string, selectors: SourceSelector[]): string[] {
    const min = Number(this.config.get<string>('JOKES_MIN_LENGTH', '40'));
    const max = Number(this.config.get<string>('JOKES_MAX_LENGTH', '600'));
    const jokes: string[] = [];

    // Пробуем специфичные селекторы
    for (const sel of selectors) {
      // Сбрасываем lastIndex для глобальных regex
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

    // Универсальный fallback: все <p> теги
    if (jokes.length < 5) {
      const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      for (const m of html.matchAll(pRe)) {
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

  /** Дедупликация: нормализуем текст перед сравнением (убираем пробелы, lowercase) */
  private deduplicate(jokes: string[]): string[] {
    const seen = new Map<string, string>(); // нормализованный → оригинал
    for (const joke of jokes) {
      const key = this.normalizeKey(joke);
      if (!seen.has(key)) {
        seen.set(key, joke);
      }
    }
    return Array.from(seen.values());
  }

  /** Очистить HTML: убрать теги, декодировать entities, нормализовать переносы */
  private cleanHtml(raw: string): string {
    return (
      raw
        // Удаляем скрипты и стили целиком
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        // Заголовки h1-h4 — это названия анекдота на сайте, не сам текст.
        // Удаляем вместе с содержимым чтобы не слипались с телом анекдота.
        .replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/gi, '')
        // Блочные элементы → перенос строки
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/blockquote>/gi, '\n')
        // Все оставшиеся теги — просто убираем
        .replace(/<[^>]+>/g, '')
        // HTML entities
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
        // Нормализация пробелов и переносов
        .replace(/[ \t]+/g, ' ') // множественные пробелы → один
        .replace(/ \n/g, '\n') // пробел перед переносом → убрать
        .replace(/\n /g, '\n') // пробел после переноса → убрать
        .replace(/\n{3,}/g, '\n\n') // 3+ переноса → 2
        .trim()
    );
  }

  /** Эвристика: текст похож на испанский */
  private looksSpanish(text: string): boolean {
    const spanishChars = /[áéíóúñ¿¡üÁÉÍÓÚÑÜ]/;
    const spanishWords =
      /\b(que|por|qué|una|este|esto|cuando|como|cómo|porque|tiene|dice|hace|para)\b/i;
    return spanishChars.test(text) || spanishWords.test(text);
  }

  /**
   * Фильтр мусора — отсеивает тексты, которые явно не являются анекдотами:
   * - Описания сайтов ("está concebido únicamente para...")
   * - Тексты с URL, email, копирайтами
   * - Слишком короткие или слишком длинные одиночные предложения без диалога
   * - Навигационные тексты (Inicio, Siguiente, Categorías...)
   */
  private isGarbage(text: string): boolean {
    // Мета-тексты сайтов
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

    // Содержит URL или email
    if (/https?:\/\//.test(text)) return true;
    if (/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return true;
    if (/©|copyright/i.test(text)) return true;

    // Нет ни одного знака конца предложения — скорее навигация
    if (!/[.!?]/.test(text)) return true;

    // Слишком много заглавных слов (nav/header)
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
