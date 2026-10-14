#!/usr/bin/env node
import { connect } from 'node:net'

const port = Number(process.env.CROSSGRAM_PORT ?? 4430)

await new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.setTimeout(4000)
  socket.once('connect', () => {
    socket.end()
    resolve()
  })
  socket.once('timeout', () => {
    socket.destroy()
    reject(new Error(`MTProto listener did not accept a connection on ${port}`))
  })
  socket.once('error', reject)
})
