# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/theurgi/igloo/security/advisories/new). Please don't
open a public issue or pull request for it.

Say what you did, what was reached that should not have been, and which invariant it breaks if you
know. Include `igloo report`'s output, run in the project: the version, `igloo doctor`'s output and
the latest boot record, with what identifies your machine replaced. Read it before you send it.

## Scope

What igloo guarantees is the list of invariants in [`ARCHITECTURE.md`](ARCHITECTURE.md#invariants).
A way to break any of them is a vulnerability: a guest reaching a file, a credential, a network
destination or a service on the host that an invariant keeps from it; a credential's value turning
up where its mode does not send it; a content module overriding policy; a runner's build running
something that can reach the network.

These are not:

- What the README's [threat model](README.md#what-it-protects-against) says igloo does not protect:
  anything the guest can already reach, a credential delivered into the guest, and files the guest
  wrote, once something on the host runs them.
- A limit an invariant states, such as UDP from the broker or vsock from the forwards. A way past
  one that is not stated is in scope.
- `igloo fallback`, which is weaker isolation by design.
- A bug in KVM, QEMU, virtiofsd, OpenSSH, systemd, Nix or the kernel, which is for that project to
  fix. What a process exploiting one could then reach on the host is igloo's, and in scope.
