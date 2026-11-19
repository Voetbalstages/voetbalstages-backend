import { beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
// Only the binary download/cache helper: mongodb-memory-server's own driver (bson 7) does not load on Bun.
import { MongoBinary } from 'mongodb-memory-server-core/lib/util/MongoBinary.js'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })

const canConnect = (port: number) =>
  new Promise<boolean>(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    sock.on('connect', () => (sock.destroy(), resolve(true)))
    sock.on('error', () => resolve(false))
  })

const dbPath = mkdtempSync(path.join(tmpdir(), 'vs-test-mongo-'))
const port = await freePort()
const mongod = Bun.spawn(
  [await MongoBinary.getPath(), '--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'],
  { stdout: 'ignore', stderr: 'ignore' }
)
const stopMongo = () => {
  mongod.kill()
  rmSync(dbPath, { recursive: true, force: true })
}
process.on('exit', stopMongo)
for (let i = 0; !(await canConnect(port)); i++) {
  if (i > 300) throw new Error('mongod did not start')
  await Bun.sleep(100)
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: `mongodb://127.0.0.1:${port}/voetbalstages_test`,
  API_URL: 'https://api.test',
  SHOP_URL: 'https://shop.test',
  ADMIN_URL: 'https://admin.test',
  CORS_ORIGINS: 'https://shop.test,https://admin.test',
  TRUSTED_PROXY_COUNT: '1',
  MAIL_DISABLED: 'true',
  MOLLIE_TESTMODE: 'true',
  APPLICATION_FEE: '1'
})

const { default: mongoose } = await import('mongoose')
const { connectDb, disconnectDb } = await import('../src/db/connection.js')
const { outbox } = await import('../src/services/mailer.js')
const { emailLimiter, ipLimiter } = await import('../src/routes/auth.js')
const { setMollieGateway } = await import('../src/services/mollie.js')

await connectDb(process.env.MONGO_URI!)

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections()
  await Promise.all(collections.map(c => c.deleteMany({})))
  outbox.length = 0
  emailLimiter.reset()
  ipLimiter.reset()
  setMollieGateway(null)
})

afterAll(async () => {
  await disconnectDb()
  stopMongo()
})
