export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export function createLogger(minLevel: LogLevel = 'info', enabled = true): Logger {
  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message: msg, ...data })
    if (level === 'error' || level === 'warn') {
      process.stderr.write(entry + '\n')
    } else {
      process.stdout.write(entry + '\n')
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info:  (msg, data) => log('info',  msg, data),
    warn:  (msg, data) => log('warn',  msg, data),
    error: (msg, data) => log('error', msg, data),
  }
}
