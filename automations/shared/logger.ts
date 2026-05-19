import pino from 'pino';

export function createLogger(name: string): pino.Logger {
  return pino({ name });
}
