/**
 * The guest CID for a VM's vsock management channel, derived from the VM's
 * identity rather than handed out by an allocator. Nothing has to be recorded
 * between runs and no two processes have to agree on who holds what: the same
 * VM gets the same CID on every boot, on any host.
 *
 * A collision is possible and is not silent. Two live VMs on one CID means the
 * second QEMU cannot bind its vhost-vsock device and exits during boot, which
 * the readiness wait reports.
 *
 * The identity to pass is the project's **canonical root path** — resolved
 * through symlinks with any trailing slash removed, so that every way of
 * naming one project hashes the same. A path is unique by construction where a
 * name is unique only by convention. Until the project layer exists the CLI
 * passes the VM's name, which is the only identity it has.
 */

/**
 * CIDs 0, 1 and 2 are reserved by the kernel — hypervisor, local, host — and
 * 0xFFFFFFFF is `VMADDR_CID_ANY`.
 *
 * The floor is well above the reserved range so that everything a person is
 * likely to type, and every CID hardcoded in a test or a harness, sits below
 * any CID this derives. Nothing enforces that convention; it only holds while
 * hand-picked CIDs stay small.
 */
export const MIN = 0x10000
export const MAX = 0xfffffffe

/**
 * FNV-1a, 32-bit. The hash must produce the same number for the same identity
 * on every host and in every future version — a CID that shifts is a running
 * VM the host can no longer reach — so it is written out here rather than taken
 * from a runtime whose implementation is free to change.
 *
 * `Math.imul` keeps the multiply in 32-bit two's complement; a plain `*`
 * overflows into a double and loses the low bits that carry the mixing.
 */
export const forIdentity = (identity: string): number => {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(identity)) {
    hash = Math.imul(hash ^ byte, 0x01000193)
  }
  return MIN + ((hash >>> 0) % (MAX - MIN + 1))
}
