type LogContext = Record<string, unknown>

function write(level: string, ctx: LogContext, msg: string, extra?: LogContext) {
  console.log(JSON.stringify({ level, msg, ...ctx, ...extra, ts: new Date().toISOString() }))
}

function makeLogger(ctx: LogContext = {}) {
  return {
    info: (extra: LogContext | string, msg?: string) => {
      if (typeof extra === 'string') write('info', ctx, extra)
      else write('info', ctx, msg ?? '', extra)
    },
    error: (extra: LogContext | string, msg?: string) => {
      if (typeof extra === 'string') write('error', ctx, extra)
      else write('error', ctx, msg ?? '', extra)
    },
    child: (childCtx: LogContext) => makeLogger({ ...ctx, ...childCtx }),
  }
}

export const logger = makeLogger()
