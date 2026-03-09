export function parseClockToMinutes(input: string, fallback: number): number {
  const match = String(input || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return hours * 60 + minutes;
}

export function formatMinutesAsClock(totalMinutes: number): string {
  const clamped = Math.max(0, totalMinutes);
  const hours = Math.floor(clamped / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (clamped % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function getDateStringInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(date);
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

export function zonedDateTimeToUtc(
  dateString: string,
  minutes: number,
  timeZone: string,
): Date {
  const [yearRaw, monthRaw, dayRaw] = dateString.split('-').map(Number);
  const year = yearRaw || 1970;
  const month = monthRaw || 1;
  const day = dayRaw || 1;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  for (let i = 0; i < 4; i++) {
    const zoned = getZonedParts(guess, timeZone);
    const actual = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
    );
    const target = Date.UTC(year, month - 1, day, hour, minute);
    const diff = actual - target;

    if (diff === 0) return guess;
    guess = new Date(guess.getTime() - diff);
  }

  return guess;
}

export function computeEvenlySpacedMinutes(
  count: number,
  startMinutes: number,
  endMinutes: number,
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [startMinutes];
  if (endMinutes <= startMinutes) return [startMinutes];

  const span = endMinutes - startMinutes;
  const step = span / (count - 1);

  return Array.from({ length: count }, (_, index) =>
    Math.round(startMinutes + step * index),
  );
}

export function isValidDateOnly(dateString: string): boolean {
  const match = String(dateString)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function toDateOnly(dateString: string): Date {
  if (!isValidDateOnly(dateString)) {
    throw new Error(`Invalid date: ${dateString}`);
  }
  return new Date(`${dateString}T00:00:00.000Z`);
}

export function shortYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/shorts/${videoId}`;
}

export function toErrorMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  if (message == null) {
    return '';
  }
  try {
    return JSON.stringify(message);
  } catch {
    return Object.prototype.toString.call(message) as string;
  }
}

export function clipError(message: unknown, max = 1400): string {
  const text = toErrorMessage(message);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
