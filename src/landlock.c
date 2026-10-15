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
 * Left open: UDP, which this ABI does not cover; a listen on a TCP socket never
 * bound, which the kernel binds to a port of its own choosing without asking
 * Landlock; Unix sockets with a path, which are files, and governed as files
 * are; and each PORT named, on every address.
 *
 * Needs Landlock ABI 6, from Linux 6.12, the first that scopes abstract
 * sockets. Without it this refuses to run COMMAND rather than run it
 * unrestricted. --check restricts this process the same way and exits 0
 * instead of running anything.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/landlock.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

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
   * itself: nothing COMMAND runs may gain privilege the restriction did not
   * account for. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die_errno("cannot set no_new_privs");
  if (syscall(__NR_landlock_restrict_self, fd, 0) != 0) die_errno("cannot restrict this process");
  close(fd);
  free(rules);
  if (check) return 0;

  execvp(argv[at + 1], argv + at + 1);
  die_errno("cannot run %s", argv[at + 1]);
}
