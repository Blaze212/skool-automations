import pino from 'npm:pino'

export const logger = pino({ level: 'info' }, {
  write(msg: string) {
    console.log(msg.trimEnd())
  },
})
