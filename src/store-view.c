/*
 * igloo-store-view PATHS COMMAND [ARG...]
 *
 * Run COMMAND in a new user and mount namespace whose /nix/store is a
 * read-only tmpfs holding only the store paths PATHS lists, each bound
 * read-only at its own name. PATHS has one absolute store path per line.
 *
 * Each path costs one bind and one remount, made with mount(2) directly, so
 * the setup is linear in the number of paths and has no argument limit. A tool
 * that locates each mount it makes by re-reading /proc/self/mountinfo is
 * quadratic here, and closures run to thousands of paths.
 *
 * Unprivileged. The namespace maps the caller's uid and gid to themselves and
 * nothing else, so root-owned store files read as the overflow id. The
 * capabilities the namespace grants are dropped at the exec, since the mapped
 * uid is not 0 and none are made ambient.
 *
 * The store the paths are bound from stays mounted beneath the tmpfs, reachable
 * only through a descriptor that is closed before the exec. The rest of the
 * filesystem is the caller's, unchanged.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define STORE "/nix/store"

static _Noreturn void die(const char *fmt, ...) {
  va_list ap;
  fputs("igloo-store-view: ", stderr);
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
  fputs("igloo-store-view: ", stderr);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fprintf(stderr, ": %s\n", strerror(saved));
  exit(1);
}

static void write_file(const char *path, const char *contents) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) die_errno("cannot open %s", path);
  size_t length = strlen(contents);
  if (write(fd, contents, length) != (ssize_t)length) die_errno("cannot write %s", path);
  if (close(fd) != 0) die_errno("cannot write %s", path);
}

/*
 * The names under /nix/store that PATHS lists, validated: each line is
 * /nix/store/<name> with a name that is one path component. Anything else is
 * refused rather than skipped, since a line this cannot read is a line whose
 * path the guest would silently go without.
 */
static char **read_names(const char *file, size_t *count) {
  FILE *in = fopen(file, "re");
  if (in == NULL) die_errno("cannot read %s", file);

  size_t capacity = 1024;
  char **names = malloc(capacity * sizeof *names);
  if (names == NULL) die("out of memory");
  *count = 0;

  char *line = NULL;
  size_t size = 0;
  ssize_t length;
  size_t number = 0;
  const size_t prefix = strlen(STORE "/");
  while ((length = getline(&line, &size, in)) != -1) {
    number++;
    if (length > 0 && line[length - 1] == '\n') line[--length] = '\0';
    const char *name = line + prefix;
    if ((size_t)length <= prefix || strncmp(line, STORE "/", prefix) != 0 || strchr(name, '/') != NULL ||
        strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
      die("%s:%zu is not a store path of the form " STORE "/<name>", file, number);
    }
    if (*count == capacity) {
      capacity *= 2;
      names = realloc(names, capacity * sizeof *names);
      if (names == NULL) die("out of memory");
    }
    names[*count] = strdup(name);
    if (names[*count] == NULL) die("out of memory");
    (*count)++;
  }
  if (ferror(in)) die_errno("cannot read %s", file);
  free(line);
  fclose(in);
  return names;
}

int main(int argc, char **argv) {
  if (argc < 3) die("usage: igloo-store-view PATHS COMMAND [ARG...]");

  size_t count;
  char **names = read_names(argv[1], &count);
  /* The alternative to refusing is serving a store with nothing in it, which
   * fails later and further from the cause. */
  if (count == 0) die("%s lists no store paths", argv[1]);

  uid_t uid = getuid();
  gid_t gid = getgid();
  /* As root the namespace would map root to root, so COMMAND would either keep
   * root's capabilities over the host's files or, with them dropped, be unable
   * to start a sandbox of its own. */
  if (uid == 0 || geteuid() == 0) die("runs as the user who owns the VM, not as root");
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) {
    die_errno("cannot create a user and mount namespace; unprivileged user namespaces must be enabled");
  }
  char map[64];
  write_file("/proc/self/setgroups", "deny");
  snprintf(map, sizeof map, "%u %u 1\n", (unsigned)uid, (unsigned)uid);
  write_file("/proc/self/uid_map", map);
  snprintf(map, sizeof map, "%u %u 1\n", (unsigned)gid, (unsigned)gid);
  write_file("/proc/self/gid_map", map);

  /* Nothing mounted here may propagate back to the caller's namespace. */
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) die_errno("cannot make / private");

  /* Held so the store stays reachable once the tmpfs covers it. Sources are
   * named through it as /proc/self/fd/<fd>/<name>. */
  int store = open(STORE, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (store < 0) die_errno("cannot open " STORE);
  if (mount("tmpfs", STORE, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755") != 0) {
    die_errno("cannot mount a tmpfs on " STORE);
  }
  int view = open(STORE, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (view < 0) die_errno("cannot open the tmpfs on " STORE);

  /* Remounting a bind cannot clear a flag the caller's mount locks, and leaves
   * the atime flags as they are when none is given — so this set only ever
   * adds restrictions. Not noexec: COMMAND runs from one of these paths. */
  const unsigned long readonly = MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV;

  char source[PATH_MAX];
  char target[PATH_MAX];
  char link[PATH_MAX];
  for (size_t i = 0; i < count; i++) {
    const char *name = names[i];
    struct stat st;
    if (fstatat(store, name, &st, AT_SYMLINK_NOFOLLOW) != 0) die_errno("cannot stat " STORE "/%s", name);

    /* Recreated rather than bound: binding one follows it, and its target is
     * resolved from here, where it may name somewhere outside the store. The
     * guest resolves it in its own store instead, as it would any other link. */
    if (S_ISLNK(st.st_mode)) {
      ssize_t length = readlinkat(store, name, link, sizeof link - 1);
      if (length < 0) die_errno("cannot read the link " STORE "/%s", name);
      link[length] = '\0';
      int made = symlinkat(link, view, name);
      if (made != 0 && errno == EEXIST) die("%s lists " STORE "/%s twice", argv[1], name);
      if (made != 0) die_errno("cannot recreate the link " STORE "/%s", name);
      continue;
    }

    int made;
    if (S_ISDIR(st.st_mode)) {
      made = mkdirat(view, name, 0755);
    } else if (S_ISREG(st.st_mode)) {
      made = openat(view, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
      if (made >= 0) made = close(made);
    } else {
      die(STORE "/%s is not a file, a directory or a symbolic link", name);
    }
    if (made != 0 && errno == EEXIST) die("%s lists " STORE "/%s twice", argv[1], name);
    if (made != 0) die_errno("cannot make a mount point for " STORE "/%s", name);

    snprintf(source, sizeof source, "/proc/self/fd/%d/%s", store, name);
    snprintf(target, sizeof target, STORE "/%s", name);
    if (mount(source, target, NULL, MS_BIND, NULL) != 0) die_errno("cannot bind " STORE "/%s", name);
    if (mount(NULL, target, NULL, readonly, NULL) != 0) die_errno("cannot make " STORE "/%s read-only", name);
  }

  close(store);
  close(view);
  if (mount(NULL, STORE, NULL, readonly, NULL) != 0) die_errno("cannot make the tmpfs on " STORE " read-only");

  /* The exec drops every capability already; emptying the bounding set as well
   * means nothing COMMAND runs can be granted one back. */
  for (int cap = 0; prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) == 0; cap++) {
  }
  if (errno != EINVAL) die_errno("cannot drop the capability bounding set");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die_errno("cannot set no_new_privs");

  execvp(argv[2], argv + 2);
  die_errno("cannot run %s, which has to be inside one of the paths %s lists", argv[2], argv[1]);
}
