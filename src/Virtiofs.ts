import { Effect, FileSystem } from 'effect'

import { storeDir } from './StoreView.ts'

/**
 * One virtiofs share, as the built runner declares it.
 *
 * `socket` is relative: QEMU addresses the vhost-user sockets by name from its
 * own working directory, so the daemon has to bind one there rather than at an
 * absolute path of the host's choosing.
 */
export interface Share {
  readonly socket: string
  readonly source: string
  readonly tag: string
}

/**
 * The virtiofs shares a built runner declares, read from
 * `share/microvm/virtiofs/<tag>/` inside the runner package.
 *
 * Read rather than recomputed. Host and guest have to agree on every socket
 * name or QEMU connects to nothing, and the name is derived from the guest's
 * hostname — which the host does not otherwise know. Sorted, so the daemons are
 * started in the same order every time.
 */
export const shares = Effect.fnUntraced(function* (outPath: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = `${outPath}/share/microvm/virtiofs`
  const tags = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  const found: Array<Share> = []
  for (const tag of tags.toSorted()) {
    const field = (name: string): Effect.Effect<string> =>
      fs.readFileString(`${dir}/${tag}/${name}`).pipe(
        Effect.map(contents => contents.trim()),
        Effect.orElseSucceed(() => ''),
      )
    const socket = yield* field('socket')
    const source = yield* field('source')
    // A 9p share, or a DAX share on a hypervisor that serves it itself, has no
    // socket and no daemon. Neither applies here, but a half-written entry
    // should be skipped rather than turned into a daemon with an empty path.
    if (socket !== '' && source !== '') found.push({ socket, source, tag })
  }
  return found
})

/**
 * The argument vector for one share's daemon.
 *
 * These flags are not a transcription of a generated script; what is preserved
 * is the behaviour the rest of the system depends on.
 *
 * `--sandbox=namespace` and `--seccomp=kill` are virtiofsd's defaults, stated
 * because the host's boundary rests on them. What serves the guest is a worker
 * in user, mount, PID and network namespaces of its own, with its share for a
 * root and a seccomp filter that kills it for any call serving does not need —
 * no socket, no exec, no mount. An escape from it reaches the share, which the
 * guest has already. A daemon that cannot enter the sandbox exits rather than
 * serve without it. Its unit is left unconfined, because the sandbox is made of
 * namespaces and a unit that forbade making them would stop it starting.
 *
 * `--no-announce-submounts` keeps each share a single guest superblock. The
 * store is served as hundreds of bind mounts under one share, and announcing
 * them makes the guest auto-mount a virtiofs per closure path — tearing those
 * down at poweroff faults on busy inodes, the shutdown job hangs, and QEMU
 * never exits.
 *
 * `--inode-file-handles=prefer` bounds the descriptors a long-running daemon
 * holds, which is what keeps the store's inode set from reaching `ENFILE`.
 *
 * `threads` arrives resolved rather than as a shell expansion, because this may
 * run inside a mount namespace whose `/nix/store` holds one closure: a
 * `$(nproc)` there would depend on coreutils being a member of it.
 *
 * The store's files are root's on the host, and root is not mapped into the
 * user namespace the daemon runs in, so it reads every one of them as owned by
 * the overflow id, 65534. Passed through, the guest sees a store owned by
 * `nobody`, which any tool checking a file's owner rejects — OpenSSH refuses a
 * config file that way. Translating that one id back to 0 shows the guest the
 * store as the host has it. What the namespace made for itself — the store
 * directory, and a top-level symlink recreated rather than bound — is `owner`'s
 * instead, so that id is translated to 0 as well; nothing the host store holds
 * reads as `owner`'s in there. It rules out `--posix-acl`, which the store does
 * not need: Nix strips extended attributes, ACLs among them, from every path it
 * adds.
 *
 * `--readonly` on the store makes read-only the daemon's rule rather than the
 * guest's. The guest mounts the share read-write before stacking a read-only
 * mount on top, so without it the guest's own mount would be all that stood
 * between guest root and a tmpfs held in host memory.
 */
export const argv = (options: {
  /** The ids the daemon runs as, which are the invoking user's. */
  readonly owner: { readonly gid: number; readonly uid: number }
  readonly share: Share
  readonly threads: number
  readonly virtiofsd: string
}): [string, ...string[]] => [
  options.virtiofsd,
  `--socket-path=${options.share.socket}`,
  `--shared-dir=${options.share.source}`,
  '--sandbox=namespace',
  '--seccomp=kill',
  '--thread-pool-size',
  String(options.threads),
  ...(options.share.source === storeDir
    ? [
        '--readonly',
        '--translate-uid=host:65534:0:1',
        `--translate-uid=host:${String(options.owner.uid)}:0:1`,
        '--translate-gid=host:65534:0:1',
        `--translate-gid=host:${String(options.owner.gid)}:0:1`,
      ]
    : ['--posix-acl']),
  '--xattr',
  '--cache=auto',
  '--inode-file-handles=prefer',
  '--no-announce-submounts',
]
