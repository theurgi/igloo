/*
 * igloo-landlock [RULE]... -- COMMAND [ARG...]
 * igloo-landlock [RULE]... --check
 *
 * where RULE is --connect-tcp PORT, --bind-tcp PORT, --read PATH or
 * --write PATH.
 *
 * Run COMMAND unable to reach what the user's other programs listen on through
 * the two ways a process on the host's network has left: a TCP port on any of
 * the host's addresses, loopback included, and an abstract Unix socket, which
 * has no file for a mount namespace to hide. COMMAND may connect over TCP to
 * the PORTs named by --connect-tcp and to no other, may bind the PORTs named by
 * --bind-tcp and no other, and may connect to no abstract socket made by a
 * process outside its restriction.
 *
 * With a --read or a --write, COMMAND is also kept from the rest of the file
 * system: it may read files, list directories and run programs only beneath a
 * PATH named by either, and change the file system only beneath one named by
 * --write. A PATH stands for what it resolves to when this starts, and a
 * directory for everything beneath it. Writing is confined with reading
 * because Landlock judges a file by the path it is opened through, so a hard
 * link or a rename that put a file beneath a PATH would make it readable there.
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
 * Landlock; a connection to a Unix socket with a path, which this ABI does not
 * see even with a --read, and which a mount namespace hides as it hides any
 * file; whatever a file's metadata says, its existence among it, since
 * Landlock refuses a file when it is opened and not when it is looked up; and
 * each PORT named, on every address.
 *
 * Needs Landlock ABI 6, from Linux 6.12, the first that scopes abstract
 * sockets, and seccomp filters. Without either it refuses to run COMMAND
 * rather than run it unrestricted. --check restricts this process the same
 * way and exits 0 instead of running anything.
 */
#define _GNU_SOURCE
#include <asm/unistd.h>
#include <errno.h>
#include <fcntl.h>
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
#include <sys/stat.h>
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

/* What --read allows beneath a PATH, and what --write allows besides: between
 * them, every access to the file system that ABI 6 knows. */
#define FS_READ                                                                                    \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define FS_WRITE                                                                                   \
  (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |                                 \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |   \
   LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |     \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |        \
   LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV)
/* The accesses a file has, as against a directory. The kernel refuses a rule
 * on a file that names any other. */
#define FS_FILE                                                                                    \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |     \
   LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV)

struct path_rule {
  const char *path;
  struct landlock_path_beneath_attr beneath;
};

/* PATH is opened here, so the rule is on what it resolves to now. */
static struct path_rule path_rule(const char *path, uint64_t access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) die_errno("cannot open %s", path);
  struct stat st;
  if (fstat(fd, &st) != 0) die_errno("cannot look up %s", path);
  return (struct path_rule){
      .path = path,
      .beneath =
          {
              .allowed_access = S_ISDIR(st.st_mode) ? access : access & FS_FILE,
              .parent_fd = fd,
          },
  };
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
  struct landlock_net_port_attr *ports = calloc((size_t)argc, sizeof *ports);
  struct path_rule *paths = calloc((size_t)argc, sizeof *paths);
  if (ports == NULL || paths == NULL) die("out of memory");
  size_t port_count = 0;
  size_t path_count = 0;
  int at = 1;
  for (; at + 1 < argc; at += 2) {
    const char *value = argv[at + 1];
    if (strcmp(argv[at], "--connect-tcp") == 0) {
      ports[port_count++] = (struct landlock_net_port_attr){
          .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
          .port = parse_port(value),
      };
    } else if (strcmp(argv[at], "--bind-tcp") == 0) {
      ports[port_count++] = (struct landlock_net_port_attr){
          .allowed_access = LANDLOCK_ACCESS_NET_BIND_TCP,
          .port = parse_port(value),
      };
    } else if (strcmp(argv[at], "--read") == 0) {
      paths[path_count++] = path_rule(value, FS_READ);
    } else if (strcmp(argv[at], "--write") == 0) {
      paths[path_count++] = path_rule(value, FS_READ | FS_WRITE);
    } else {
      break;
    }
  }
  int check = at + 1 == argc && strcmp(argv[at], "--check") == 0;
  if (!check && !(at + 1 < argc && strcmp(argv[at], "--") == 0)) {
    die("usage: igloo-landlock [--connect-tcp PORT | --bind-tcp PORT | --read PATH | --write "
        "PATH]... {--check | -- COMMAND [ARG...]}");
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
      .handled_access_fs = path_count > 0 ? FS_READ | FS_WRITE : 0,
      .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
      .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET,
  };
  int fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset, sizeof ruleset, 0);
  if (fd < 0) die_errno("cannot create a Landlock ruleset");
  /* A PORT named by both flags is two rules, which the kernel merges. */
  for (size_t i = 0; i < port_count; i++) {
    if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_NET_PORT, &ports[i], 0) != 0) {
      die_errno("cannot allow TCP port %llu", (unsigned long long)ports[i].port);
    }
  }
  /* So is a PATH named twice, or one beneath another: an access is allowed
   * beneath any rule that allows it. */
  for (size_t i = 0; i < path_count; i++) {
    struct landlock_path_beneath_attr *rule = &paths[i].beneath;
    if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, rule, 0) != 0) {
      die_errno("cannot allow %s", paths[i].path);
    }
    close(rule->parent_fd);
  }

  /* The kernel requires it before a process without CAP_SYS_ADMIN restricts
   * itself, by Landlock or by seccomp: nothing COMMAND runs may gain privilege
   * the restriction did not account for. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die_errno("cannot set no_new_privs");
  if (syscall(__NR_landlock_restrict_self, fd, 0) != 0) die_errno("cannot restrict this process");
  close(fd);
  free(ports);
  free(paths);
  refuse_ungoverned_sockets();
  if (check) return 0;

  execvp(argv[at + 1], argv + at + 1);
  die_errno("cannot run %s", argv[at + 1]);
}
