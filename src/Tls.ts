/**
 * The broker's TLS identity for one project: a certificate authority the guest
 * trusts, limited to the names the broker answers, and the certificate and key
 * the broker answers them with.
 *
 * Made with `openssl` on first use and kept in the project, as the key the
 * host connects with is: the authority's certificate is built into the runner,
 * so a new one changes a build input. Made again when what is kept no longer
 * covers exactly the names asked for, or is near its end.
 *
 * The authority's own key signs the certificate and is then deleted, so what is
 * kept can sign nothing. The key kept is the certificate's, which answers those
 * names to this project's guest and does nothing anywhere else.
 */

import { Clock, Effect, FileSystem, Option, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import * as path from 'node:path'

export class TlsError extends Schema.TaggedError<TlsError>()('TlsError', {
  message: Schema.String,
}) {}

/** What `ensure` answers: the authority's certificate itself, and where the rest is. */
export interface Identity {
  /** The authority's certificate, as PEM: what the guest trusts. */
  readonly authority: string
  /** The certificate the broker answers with, as a path. */
  readonly certificate: string
  /** Its key, as a path, readable by its owner alone. */
  readonly key: string
}

/** The files `ensure` keeps in its directory. */
export const files = {
  authority: 'authority.pem',
  certificate: 'certificate.pem',
  key: 'key.pem',
} as const

/**
 * How long each is valid for, in days. The authority outlives the certificate
 * it signs, so that no verifier finds a certificate valid past its issuer.
 */
const authorityDays = 3660
const certificateDays = 3650

/** How close to its end a certificate is made again rather than kept. */
const renewWithinMs = 30 * 24 * 60 * 60 * 1000

/**
 * Whether what is kept is still right: the authority is one, it signed the
 * certificate, the key is the certificate's, the certificate covers exactly
 * `names`, and it is not within `renewWithinMs` of its end at `nowMs`.
 *
 * Anything unreadable is not right, so it is made again rather than served.
 */
export const current = (
  kept: { readonly authority: string; readonly certificate: string; readonly key: string },
  names: readonly string[],
  nowMs: number,
): boolean => {
  try {
    const authority = new X509Certificate(kept.authority)
    const certificate = new X509Certificate(kept.certificate)
    const covered = (certificate.subjectAltName ?? '')
      .split(', ')
      .map(entry => entry.replace(/^DNS:/, ''))
      .toSorted()
    const wanted = names.toSorted()
    return (
      authority.ca &&
      !certificate.ca &&
      certificate.checkIssued(authority) &&
      certificate.verify(authority.publicKey) &&
      certificate.checkPrivateKey(createPrivateKey(kept.key)) &&
      covered.length === wanted.length &&
      covered.every((name, at) => name === wanted[at]) &&
      certificate.validToDate.getTime() - nowMs > renewWithinMs
    )
  } catch {
    return false
  }
}

/**
 * `openssl`'s configuration for both certificates, written beside them rather
 * than taken from the host's, so that nothing in the host's `openssl.cnf` adds
 * to what either holds.
 *
 * The authority may sign certificates and nothing else, none of them another
 * authority, and only for `names`. The certificate is not an authority, and
 * serves TLS for `names`.
 */
const configuration = (names: readonly string[]): string =>
  [
    '[req]',
    'distinguished_name = name',
    'prompt = no',
    '[name]',
    'CN = igloo broker',
    '[authority]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign',
    `nameConstraints = critical,${names.map(name => `permitted;DNS:${name}`).join(',')}`,
    'subjectKeyIdentifier = hash',
    '[certificate]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${names.map(name => `DNS:${name}`).join(',')}`,
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid',
    '',
  ].join('\n')

/**
 * Make an authority and a certificate for `names` in `dir`, replacing what is
 * there. The authority's key is made in a directory removed when this ends,
 * however it ends.
 */
const make = Effect.fnUntraced(function* (dir: string, names: readonly string[]) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const failed = (doing: string) => () => new TlsError({ message: `cannot ${doing} in ${dir}` })

  return yield* Effect.gen(function* () {
    const work = yield* fs
      .makeTempDirectoryScoped({ directory: dir, prefix: 'making-' })
      .pipe(Effect.mapError(failed('make a working directory')))
    yield* fs
      .writeFileString(path.join(work, 'openssl.cnf'), configuration(names))
      .pipe(Effect.mapError(failed('write openssl.cnf')))

    const common = ['-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc']
    for (const args of [
      [
        'req',
        '-config',
        'openssl.cnf',
        ...common,
        '-extensions',
        'authority',
        '-days',
        String(authorityDays),
        '-keyout',
        'authority.key',
        '-out',
        files.authority,
      ],
      [
        'req',
        '-config',
        'openssl.cnf',
        ...common,
        '-extensions',
        'certificate',
        '-days',
        String(certificateDays),
        '-subj',
        `/CN=${names[0] ?? 'igloo broker'}`,
        '-CA',
        files.authority,
        '-CAkey',
        'authority.key',
        '-keyout',
        files.key,
        '-out',
        files.certificate,
      ],
    ]) {
      // Its progress goes to stderr, so that is kept for a failure to report
      // rather than shown on every first launch.
      const ran = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make('openssl', args, {
            cwd: work,
            extendEnv: true,
            stdin: 'ignore',
            stdout: 'ignore',
          }),
        )
        const said = yield* handle.stderr.pipe(Stream.decodeText, Stream.mkString)
        return { code: yield* handle.exitCode, said }
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => ({ code: 127, said: 'openssl could not be run' })),
      )
      if (ran.code !== 0) {
        return yield* new TlsError({
          message: `openssl exited ${String(ran.code)} making the broker's TLS certificate in ${dir}: ${ran.said.trim()}`,
        })
      }
    }

    yield* fs
      .chmod(path.join(work, files.key), 0o600)
      .pipe(Effect.mapError(failed('restrict the key')))
    // The authority last: a directory left with a new certificate and an old
    // authority does not verify, and is made again on the next launch.
    for (const name of [files.key, files.certificate, files.authority]) {
      yield* fs
        .rename(path.join(work, name), path.join(dir, name))
        .pipe(Effect.mapError(failed(`move ${name}`)))
    }
  }).pipe(Effect.scoped)
})

/**
 * The broker's TLS identity for `names`, made in `dir` if what is there is not
 * `current`. The directory is readable by its owner alone.
 */
export const ensure = Effect.fn('Tls.ensure')(function* (dir: string, names: readonly string[]) {
  const fs = yield* FileSystem.FileSystem
  const at = {
    authority: path.join(dir, files.authority),
    certificate: path.join(dir, files.certificate),
    key: path.join(dir, files.key),
  }

  yield* fs
    .makeDirectory(dir, { mode: 0o700, recursive: true })
    .pipe(Effect.mapError(() => new TlsError({ message: `cannot create ${dir}` })))
  yield* fs
    .chmod(dir, 0o700)
    .pipe(Effect.mapError(() => new TlsError({ message: `cannot restrict ${dir}` })))

  const kept = yield* Effect.all({
    authority: fs.readFileString(at.authority),
    certificate: fs.readFileString(at.certificate),
    key: fs.readFileString(at.key),
  }).pipe(Effect.option)
  if (Option.isNone(kept) || !current(kept.value, names, yield* Clock.currentTimeMillis)) {
    yield* make(dir, names)
  }
  const authority = yield* fs
    .readFileString(at.authority)
    .pipe(Effect.mapError(() => new TlsError({ message: `cannot read ${at.authority}` })))
  return { authority, certificate: at.certificate, key: at.key } satisfies Identity
})
