/*
 * igloo-landlock [--connect-tcp PORT | --bind-tcp PORT]... -- COMMAND [ARG...]
 * igloo-landlock [--connect-tcp PORT | --bind-tcp PORT]... --check
 *
 * Run COMMAND unable to reach what the user's other programs listen on through
 * the two ways a process on the host's network has left: a TCP port on any of
 * the host's addresses, loopback included, and an abstract Unix socket, which
 * has no file for a mount namespace to hide. COMMAND may connect over TCP to
 * the PORTs named by --connect-tcp and to no other, may bind the PORTs named by
 * --bind-tcp and no other, and may connect to no abstract socket made by a
 * process outside its restriction.
 *
 * The restriction is Landlock's, held by the kernel and kept across the exec:
 * COMMAND, every thread it starts and everything it runs inherit it, and none
 * of them can shed it. It is applied here rather than by COMMAND itself
 * because it binds only the thread that asks and the threads that thread
 * starts afterwards, and a runtime has started others before any of its code
 * could ask.
 *
 * Landlock governs TCP sockets and no others, and others reach ports too:
 * MPTCP and SMC a TCP port, each falling back to TCP against a peer without
 * it, and SCTP a port of its own. So a seccomp filter, held and kept the same
 * way, refuses with EPERM every AF_INET and AF_INET6 socket that is neither
 * TCP nor UDP; every AF_SMC socket, which is SMC as a family of its own; and
 * io_uring, whose IORING_OP_SOCKET makes a socket without calling socket().
 * A system call made through any ABI but x86_64's, whose numbers the filter
 * does not check, kills the process.
 *
 * Left open: UDP, which this ABI does not cover; a listen on a TCP socket never
 * bound, which the kernel binds to a port of its own choosing without asking
 * Landlock; Unix sockets with a path, which are files, and governed as files
 * are; and each PORT named, on every address.
 *
 * Needs Landlock ABI 6, from Linux 6.12, the first that scopes abstract
 * sockets, and seccomp filters. Without either it refuses to run COMMAND
 * rather than run it unrestricted. --check restricts this process the same
 * way and exits 0 instead of running anything.
 */
#define _GNU_SOURCE
#include <asm/unistd.h>
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__x86_64__)
#error "the system call filter checks x86_64's system call numbers alone"
#endif

#define REQUIRED_ABI 6

static _Noreturn void die(const char *fmt, ...) {
  va_list ap;
  fputs("igloo-landlock: ", stderr);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  exit(1);
}

/* errno is read before anything that could change it. */
static _Noreturn void die_errno(const char *fmt, ...) {
  int saved = errno;
  va_list ap;
  fputs("igloo-landlock: ", stderr);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fprintf(stderr, ": %s\n", strerror(saved));
  exit(1);
}

/* Digits only: strtoul alone would also take a sign and leading space. */
static uint64_t parse_port(const char *text) {
  for (const char *c = text; *c != '\0'; c++) {
    if (*c < '0' || *c > '9') die("%s is not a TCP port", text);
  }
  errno = 0;
  unsigned long port = strtoul(text, NULL, 10);
  if (text[0] == '\0' || errno != 0 || port == 0 || port > 65535) die("%s is not a TCP port", text);
  return port;
}

/* The filter's steps. A load reads 32 bits, and on x86_64 the low half of a
 * 64-bit argument comes first: all of an int, which is all the kernel reads of
 * each of socket()'s. */
#define LOAD(field) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, field))
#define RETURN(action) BPF_STMT(BPF_RET | BPF_K, (action))
/* IF_IS returns ACTION when what was loaded is K, UNLESS when it is not, and
 * each otherwise goes on to the step after it. */
#define IF_IS(k, action) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (k), 0, 1), RETURN(action)
#define UNLESS(k, action) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (k), 1, 0), RETURN(action)
#define ALLOW SECCOMP_RET_ALLOW
#define REFUSE (SECCOMP_RET_ERRNO | EPERM)
#define KILL SECCOMP_RET_KILL_PROCESS

/* Refuses the sockets Landlock does not govern that reach a port, and io_uring,
 * which makes sockets without calling socket(). */
static void refuse_ungoverned_sockets(void) {
  struct sock_filter program[] = {
      LOAD(arch),
      UNLESS(AUDIT_ARCH_X86_64, KILL),
      LOAD(nr),
      /* x32's calls arrive as x86_64's with this bit set in the number. */
      BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, __X32_SYSCALL_BIT, 0, 1),
      RETURN(KILL),
      IF_IS(__NR_io_uring_setup, REFUSE),
      UNLESS(__NR_socket, ALLOW),

      LOAD(args[0]),
      IF_IS(AF_SMC, REFUSE),
      /* AF_INET goes on past the next two, as AF_INET6 does. */
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0),
      UNLESS(AF_INET6, ALLOW),

      /* The type without the flags socket() also takes in it. */
      LOAD(args[1]),
      BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(uint32_t)(SOCK_NONBLOCK | SOCK_CLOEXEC)),
      /* Anything but a stream goes on past the six that check its protocol.
       * Protocol 0 is the type's default: TCP for a stream, UDP for a
       * datagram. */
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 0, 6),
      LOAD(args[2]),
      IF_IS(0, ALLOW),
      IF_IS(IPPROTO_TCP, ALLOW),
      RETURN(REFUSE),
      UNLESS(SOCK_DGRAM, REFUSE),
      LOAD(args[2]),
      IF_IS(0, ALLOW),
      IF_IS(IPPROTO_UDP, ALLOW),
      RETURN(REFUSE),
  };
  struct sock_fprog filter = {
      .len = (unsigned short)(sizeof program / sizeof program[0]),
      .filter = program,
  };
  if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &filter) != 0) {
    die_errno("cannot install the system call filter");
  }
}

int main(int argc, char **argv) {
  struct landlock_net_port_attr *rules = calloc((size_t)argc, sizeof *rules);
  if (rules == NULL) die("out of memory");
  size_t count = 0;
  int at = 1;
  for (; at + 1 < argc; at += 2) {
    uint64_t access;
    if (strcmp(argv[at], "--connect-tcp") == 0) {
      access = LANDLOCK_ACCESS_NET_CONNECT_TCP;
    } else if (strcmp(argv[at], "--bind-tcp") == 0) {
      access = LANDLOCK_ACCESS_NET_BIND_TCP;
    } else {
      break;
    }
    rules[count++] = (struct landlock_net_port_attr){
        .allowed_access = access,
        .port = parse_port(argv[at + 1]),
    };
  }
  int check = at + 1 == argc && strcmp(argv[at], "--check") == 0;
  if (!check && !(at + 1 < argc && strcmp(argv[at], "--") == 0)) {
    die("usage: igloo-landlock [--connect-tcp PORT | --bind-tcp PORT]... {--check | -- COMMAND "
        "[ARG...]}");
  }

  int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0 && (errno == ENOSYS || errno == EOPNOTSUPP)) {
    die("this kernel has no Landlock enabled; it is missing from /sys/kernel/security/lsm");
  }
  if (abi < 0) die_errno("cannot ask the kernel which Landlock it has");
  if (abi < REQUIRED_ABI) {
    die("this kernel has Landlock ABI %d, and abstract Unix sockets need %d, from Linux 6.12", abi,
        REQUIRED_ABI);
  }

  struct landlock_ruleset_attr ruleset = {
      .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
      .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET,
  };
  int fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset, sizeof ruleset, 0);
  if (fd < 0) die_errno("cannot create a Landlock ruleset");
  /* A PORT named by both flags is two rules, which the kernel merges. */
  for (size_t i = 0; i < count; i++) {
    if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_NET_PORT, &rules[i], 0) != 0) {
      die_errno("cannot allow TCP port %llu", (unsigned long long)rules[i].port);
    }
  }

  /* The kernel requires it before a process without CAP_SYS_ADMIN restricts
   * itself, by Landlock or by seccomp: nothing COMMAND runs may gain privilege
   * the restriction did not account for. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die_errno("cannot set no_new_privs");
  if (syscall(__NR_landlock_restrict_self, fd, 0) != 0) die_errno("cannot restrict this process");
  close(fd);
  free(rules);
  refuse_ungoverned_sockets();
  if (check) return 0;

  execvp(argv[at + 1], argv + at + 1);
  die_errno("cannot run %s", argv[at + 1]);
}
