import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Clock, Effect, FileSystem, Scope } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { X509Certificate } from 'node:crypto'
import { connect } from 'node:tls'

import * as Tls from './Tls.ts'

const provided = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

/** What `ensure` kept, read back as text. */
const keptIn = Effect.fnUntraced(function* (identity: Tls.Identity) {
  const fs = yield* FileSystem.FileSystem
  return {
    authority: identity.authority,
    certificate: yield* fs.readFileString(identity.certificate),
    key: yield* fs.readFileString(identity.key),
  }
})

/**
 * Whether a client trusting `ca` completes a handshake for `name` with a
 * server holding `identity`, which listens for as long as the scope is open.
 */
const handshake = Effect.fnUntraced(function* (
  identity: { readonly cert: string; readonly key: string },
  ca: string,
  name: string,
) {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          data() {
            /* nothing is read: the handshake is the question */
          },
        },
        tls: identity,
      }),
    ),
    listener => Effect.sync(() => listener.stop(true)),
  )
  return yield* Effect.callback<boolean>(resume => {
    const client = connect({ ca, host: '127.0.0.1', port: server.port, servername: name })
    client.once('secureConnect', () => {
      client.end()
      resume(Effect.succeed(true))
    })
    client.once('error', () => {
      resume(Effect.succeed(false))
    })
  })
})

describe('Tls.ensure', () => {
  it.live(
    'makes an authority limited to the names and a certificate it signed for them, keeping no key that signs',
    () =>
      provided(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = `${yield* fs.makeTempDirectoryScoped()}/tls`
          const identity = yield* Tls.ensure(dir, ['github.com'])

          const authority = new X509Certificate(identity.authority)
          const certificate = new X509Certificate(yield* fs.readFileString(identity.certificate))
          assert.isTrue(authority.ca)
          assert.isFalse(certificate.ca)
          assert.isTrue(certificate.checkIssued(authority))
          assert.strictEqual(certificate.subjectAltName, 'DNS:github.com')
          assert.isTrue(
            Tls.current(yield* keptIn(identity), ['github.com'], yield* Clock.currentTimeMillis),
          )

          assert.deepStrictEqual((yield* fs.readDirectory(dir)).toSorted(), [
            Tls.files.authority,
            Tls.files.certificate,
            Tls.files.key,
          ])
          assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700)
          assert.strictEqual((yield* fs.stat(identity.key)).mode & 0o777, 0o600)
        }),
      ),
  )

  it.live('makes a certificate a client trusting the authority accepts for those names alone', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const identity = yield* Tls.ensure(dir, ['github.com'])
        const served = {
          cert: yield* fs.readFileString(identity.certificate),
          key: yield* fs.readFileString(identity.key),
        }
        assert.isTrue(yield* handshake(served, identity.authority, 'github.com'))
        assert.isFalse(yield* handshake(served, identity.authority, 'example.com'))
      }),
    ),
  )

  it.live('keeps what it made while that covers the names, and makes it again when not', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const first = yield* Tls.ensure(dir, ['github.com'])
        const again = yield* Tls.ensure(dir, ['github.com'])
        assert.strictEqual(again.authority, first.authority)

        const wider = yield* Tls.ensure(dir, ['github.com', 'api.github.com'])
        assert.notStrictEqual(wider.authority, first.authority)
        assert.strictEqual(
          new X509Certificate(yield* fs.readFileString(wider.certificate)).subjectAltName,
          'DNS:github.com, DNS:api.github.com',
        )

        // A key that is not the certificate's is made again rather than served.
        yield* fs.writeFileString(wider.key, 'not a key')
        const mended = yield* Tls.ensure(dir, ['github.com', 'api.github.com'])
        assert.notStrictEqual(mended.authority, wider.authority)
        assert.isTrue(
          Tls.current(
            yield* keptIn(mended),
            ['github.com', 'api.github.com'],
            yield* Clock.currentTimeMillis,
          ),
        )
      }),
    ),
  )
})

describe('Tls.current', () => {
  it.live('holds what is kept to the names and to the time left on it', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const kept = yield* keptIn(
          yield* Tls.ensure(yield* fs.makeTempDirectoryScoped(), ['github.com']),
        )
        const now = yield* Clock.currentTimeMillis
        assert.isTrue(Tls.current(kept, ['github.com'], now))
        assert.isFalse(Tls.current(kept, ['github.com', 'api.github.com'], now))
        assert.isFalse(Tls.current(kept, [], now))
        const nearItsEnd =
          new X509Certificate(kept.certificate).validToDate.getTime() - 24 * 60 * 60 * 1000
        assert.isFalse(Tls.current(kept, ['github.com'], nearItsEnd))
        assert.isFalse(
          Tls.current({ ...kept, certificate: 'not a certificate' }, ['github.com'], now),
        )
      }),
    ),
  )
})
