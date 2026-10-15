# The floor: enough to attach to a VM, read a file, and let a language
# package manager bootstrap itself. Everything else — editors, language
# toolchains, agents — belongs in a caller's `contentModules`, since each
# addition here lands in every VM's closure and in the inode set virtiofsd
# has to serve.
#
# `cacert` is the non-obvious member: without it nothing completes a TLS
# handshake, so a package manager cannot fetch anything.
p: with p; [
  bash
  cacert
  coreutils
  diffutils
  findutils
  gawk
  gnugrep
  gnused
  gnutar
  gzip
  less
  ncurses
  openssh
  which
  xz
]
