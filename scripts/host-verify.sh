#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted strings here are code for the guest, sh -c, bun or nix to expand
#
# igloo's end-to-end check, run on a host. From the devshell, in a checkout of
# this repo:
#
#     nix develop --command ./scripts/host-verify.sh
#
# It builds runners, tries to subvert them from a content module, probes what
# Landlock keeps from a process, launches a throwaway VM, looks inside it and
# at the confinement of every unit it starts, and tears it down. The launches
# run the checkout's `bin/igloo` with the installed igloo's user layer, so it
# needs a NixOS host with igloo installed through both of its modules and
# `igloo doctor` passing. Expect 5-20 minutes, most of it the first guest build,
# and network: for the builds, and for checks that reach github.com,
# api.anthropic.com and other public hosts through the broker.
#
# Nothing it does touches an existing project: the VM it launches is a scratch
# project in a temporary directory, and it is stopped on the way out even if a
# check fails partway through. What it leaves is its output, and the store
# paths it built, which nothing roots once it exits.
#
# Everything it learns lands in one directory, named at the start and the end:
# IGLOO_VERIFY_OUT, or a new temporary directory. The checks that need a real
# credential, or a port of the host's, take it from the environment:
#
#   IGLOO_VERIFY_GITHUB_TOKEN      a clone through the broker with a real token
#   IGLOO_VERIFY_GITHUB_REPO       the repository it clones, git/git by default
#   IGLOO_VERIFY_GITHUB_WRITE_REPO a scratch repository with a commit, not the
#                                  one cloned, that the token can push to: a
#                                  branch is pushed to it and deleted again
#   IGLOO_VERIFY_OPENROUTER_KEY    streaming model calls with a real key, which
#                                  spend a few tokens of credit
#   IGLOO_VERIFY_OPENROUTER_MODEL  the model they name
#   IGLOO_VERIFY_PORT              the host port a guest port is published on,
#                                  45080 by default
#
# Without the token or the key, the checks behind it are skipped and noted.
#
# What it records is what the checks need and nothing else about the machine:
# program paths rather than whole command lines, file modes rather than owners,
# counts rather than lists, and only the units this run started — another
# project's VM is counted, never named. On the way out, scripts/redact.sh
# replaces what still identifies the machine or its user in text the checks do
# not choose the words of, such as nix's errors and the guest's console.

set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Checked before anything is created, so a run that cannot start leaves nothing.
unset_vars=()
for var in IGLOO_BWRAP IGLOO_LANDLOCK IGLOO_SSH_PROXY IGLOO_STORE_VIEW IGLOO_VIRTIOFSD; do
	[ -n "${!var:-}" ] || unset_vars+=("$var")
done
if [ ${#unset_vars[@]} -gt 0 ]; then
	printf 'Not in the devshell: %s unset.\n' "${unset_vars[*]}" >&2
	printf 'Run: nix develop --command ./scripts/host-verify.sh\n' >&2
	exit 2
fi

# Absolute, because the launches below run from another directory.
if [ -n "${IGLOO_VERIFY_OUT:-}" ]; then
	out=$(realpath -m -- "$IGLOO_VERIFY_OUT")
else
	out=$(mktemp -d -t "igloo-verify-$(date +%Y%m%d-%H%M%S).XXXXXX")
fi
# Never inside the checkout: every launch takes it as a `path:` input, which
# copies all of it into the store, ignored files included, so output written
# there would have each launch copy the checkout afresh.
case $out/ in
"$(realpath -- "$repo")"/*)
	printf 'IGLOO_VERIFY_OUT is inside the checkout, which every launch copies into the store.\n' >&2
	printf 'Name a directory outside %s.\n' "$repo" >&2
	exit 2
	;;
esac
scratch=$(mktemp -d -t igloo-verify.XXXXXXXX)

mkdir -p "$out/artifacts" "$out/steps"
results="$out/results.tsv"
: >"$results"

# ---------------------------------------------------------------- reporting --

pass=0
fail=0
warn=0

say() { printf '%s\n' "$*" >&2; }

verdict() { # verdict PASS|FAIL|NOTE <slug> <what it proves>
	printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$results"
	case "$1" in
	PASS) pass=$((pass + 1)) ;;
	FAIL) fail=$((fail + 1)) ;;
	*) warn=$((warn + 1)) ;;
	esac
	say "  $1  $2 — $3"
}

# How long the run took, in milliseconds: each section of this script whole,
# and each timed command under the section it ran in. One section starts where
# the one before it ends, so together they are the run from the prerequisites
# to the summary.
sections="$out/artifacts/sections.tsv"
timings="$out/artifacts/timings.tsv"
printf 'section\tms\n' >"$sections"
printf 'section\tstep\tms\n' >"$timings"
run_started=$EPOCHREALTIME
section_name=""
section_started=""

# Milliseconds between two readings of EPOCHREALTIME, whose decimal separator
# is the locale's — so it is dropped rather than parsed.
ms_between() { # ms_between <start> <end>
	printf '%s' $(((${2/[!0-9]/} - ${1/[!0-9]/}) / 1000))
}

timed() { # timed <step> <start> — how long since <start>, an EPOCHREALTIME
	printf '%s\t%s\t%s\n' "$section_name" "$1" "$(ms_between "$2" "$EPOCHREALTIME")" >>"$timings"
}

section() { # section [<name>] — ends the running section, if any, and starts <name>
	local now=$EPOCHREALTIME
	[ -z "$section_name" ] ||
		printf '%s\t%s\n' "$section_name" "$(ms_between "$section_started" "$now")" >>"$sections"
	section_name=${1:-}
	section_started=$now
}

# Run a command, keeping its output and timing it. Returns the command's exit
# status.
step() { # step <slug> -- cmd...
	local slug=$1 started=$EPOCHREALTIME status
	shift
	[ "${1:-}" = "--" ] && shift
	{
		printf '$ %s\n\n' "$*"
		"$@"
	} >"$out/steps/$slug.txt" 2>&1
	status=$?
	timed "$slug" "$started"
	return "$status"
}

no_evidence() { # no_evidence <file> — true when there is nothing to read
	[ ! -s "$1" ]
}

# Whether an opt-in credential arrived, without writing it down. The length is
# reported deliberately: the two ways one of these goes wrong silently are a
# variable set from a command that failed, leaving it empty, and one holding a
# placeholder rather than a key. Neither is visible any other way.
opt_in_state() { # opt_in_state <variable name>
	local value=${!1:-}
	if [ -z "$value" ]; then
		echo "unset — the check behind it will be skipped"
	else
		echo "set, ${#value} characters"
	fi
}

# ------------------------------------------------------------- prerequisites --
section "prerequisites"

say "igloo host-verify"
say "  repo    $repo"
say "  output  $out"
say ""

{
	echo "HEAD      $(git -C "$repo" rev-parse HEAD 2>/dev/null)"
	echo "status    $(git -C "$repo" status --porcelain 2>/dev/null | wc -l) modified files"
	echo "kernel    $(uname -srm)"
	echo "nproc     $(nproc)"
	echo "nix       $(nix --version)"
	echo "systemd   $(systemctl --version | head -1)"
	echo "sandbox   $(nix config show sandbox 2>&1)"
	echo
	echo "IGLOO_BWRAP      ${IGLOO_BWRAP}"
	echo "IGLOO_SSH_PROXY  ${IGLOO_SSH_PROXY}"
	echo "IGLOO_STORE_VIEW ${IGLOO_STORE_VIEW}"
	echo "IGLOO_VIRTIOFSD  ${IGLOO_VIRTIOFSD}"
	echo
	for var in IGLOO_VERIFY_GITHUB_TOKEN IGLOO_VERIFY_OPENROUTER_KEY; do
		echo "$var  $(opt_in_state "$var")"
	done
} >"$out/environment.txt"

# Said before the slow part rather than in the summary after it: an opt-in
# credential that did not arrive costs a whole run to discover otherwise.
say ""
for var in IGLOO_VERIFY_GITHUB_TOKEN IGLOO_VERIFY_OPENROUTER_KEY; do
	say "  $var  $(opt_in_state "$var")"
done
say ""

# Whether the binary answers `--version` at all, recorded separately from
# doctor's verdict: if doctor says this failed, this says whether the cause is
# the binary or the flag.
step virtiofsd-version -- "$IGLOO_VIRTIOFSD" --version

# ------------------------------------------------------- the reference build --
section "the reference build"

say "Building the reference runner (the slow part)…"
started=$EPOCHREALTIME
runner=$(nix build --no-link --print-out-paths "$repo#testVm" 2>"$out/steps/build-testvm.txt")
timed build-testvm "$started"
if [ -n "$runner" ] && [ -e "$runner" ]; then
	verdict PASS build-testvm "flake.nix evaluates and builds with the pins and the extended assertion"
	echo "$runner" >"$out/artifacts/runner-path.txt"
else
	verdict FAIL build-testvm "flake.nix no longer builds — read steps/build-testvm.txt; nothing below is meaningful"
	runner=""
fi

if [ -n "$runner" ]; then
	# The contract the host side now depends on: the runner says what to serve
	# and what to call each socket.
	step runner-declares-shares -- find "$runner/share/microvm/virtiofs" -type f -exec sh -c \
		'printf "%s = %s\n" "$1" "$(cat "$1")"' _ {} \;
	if grep -q 'ro-store/socket' "$out/steps/runner-declares-shares.txt"; then
		verdict PASS runner-declares-shares "the runner publishes a socket and source per share"
	else
		verdict FAIL runner-declares-shares "no share metadata in the runner — Virtiofs.shares has nothing to read"
	fi

	for script in microvm-run virtiofsd-run; do
		if [ -e "$runner/bin/$script" ]; then
			cp "$(readlink -f "$runner/bin/$script")" "$out/artifacts/$script.sh"
		fi
	done

	# The one that matters for the launch: virtiofsd must be a closure member,
	# because the store's daemon execs inside a namespace holding only that.
	closure="$out/artifacts/closure.txt"
	nix path-info -r "$runner" >"$closure" 2>/dev/null
	echo "closure paths: $(wc -l <"$closure")" >>"$out/environment.txt"
	if grep -qF "$(dirname "$(dirname "$IGLOO_VIRTIOFSD")")" "$closure"; then
		verdict PASS virtiofsd-in-closure "IGLOO_VIRTIOFSD is in the runner's closure, so the store daemon can exec it"
	else
		verdict FAIL virtiofsd-in-closure "IGLOO_VIRTIOFSD is not a closure member — up will refuse, and it is right to"
	fi
fi

# ------------------------------------------------------------- the broker build --
section "the broker build"

# Separate from the runner: the broker runs on the host beside the VM, so no
# runner's closure holds it, and a runner that builds says nothing about it.
broker_bin=""
started=$EPOCHREALTIME
broker_out=$(nix build --impure --no-link --print-out-paths "$repo#broker" 2>"$out/steps/build-broker.txt")
timed build-broker "$started"
if [ -n "$broker_out" ] && [ -x "$broker_out/bin/igloo-broker" ]; then
	broker_bin="$broker_out/bin/igloo-broker"
	verdict PASS build-broker "packages.broker builds and produces an executable"
	echo "$broker_bin" >"$out/artifacts/broker-path.txt"
else
	verdict FAIL build-broker "packages.broker did not build — read steps/build-broker.txt; the broker checks below will fail for this reason and no other"
fi

# ---------------------------------------------------------- what Landlock keeps --
section "what Landlock keeps"

# The helper the broker runs under, which only the host can compile or run.
# Each probe is a process the user started, the way a service of theirs would
# be: an abstract socket and a loopback port to reach, and a TCP port to listen
# on. Run plainly, the probe reaches all three, which shows it can; under the
# helper, none of them. Then once more with the loopback port allowed by name,
# which it must reach while the abstract socket stays refused.
landlock_bin=""
started=$EPOCHREALTIME
landlock_out=$(nix build --impure --no-link --print-out-paths "$repo#landlock" 2>"$out/steps/build-landlock.txt")
timed build-landlock "$started"
if [ -n "$landlock_out" ] && [ -x "$landlock_out/bin/igloo-landlock" ]; then
	landlock_bin="$landlock_out/bin/igloo-landlock"
	verdict PASS build-landlock "packages.landlock builds and produces an executable"
else
	verdict FAIL build-landlock "packages.landlock did not build — read steps/build-landlock.txt"
fi

if [ -n "$landlock_bin" ]; then
	abstract="igloo-verify-$$"
	cat >"$scratch/landlock-listen.ts" <<-'EOF'
		// landlock-listen <abstract name> — listen on it and on a loopback port,
		// print the port, and hold both until killed.
		const handler = { socket: { data() {} } }
		Bun.listen({ unix: `\0${process.argv[2]}`, ...handler })
		const tcp = Bun.listen({ hostname: '127.0.0.1', port: 0, ...handler })
		process.stdout.write(`${tcp.port}\n`)
		setInterval(() => {}, 60_000)
	EOF
	cat >"$scratch/landlock-probe.ts" <<-'EOF'
		// landlock-probe <abstract name> <port> <own port> — one line per thing
		// tried, with the kernel's errno when it was refused. Through libc, because
		// Bun reports a refused connect as ECONNREFUSED or ENOENT whatever the
		// kernel said.
		import { dlopen, ptr, read } from 'bun:ffi'
		const libc = dlopen('libc.so.6', {
			__errno_location: { args: [], returns: 'ptr' },
			bind: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
			connect: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
			listen: { args: ['i32', 'i32'], returns: 'i32' },
			socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
		})
		const names: Record<number, string> = { 1: 'EPERM', 13: 'EACCES', 111: 'ECONNREFUSED' }
		const [name = '', port = '0', own = '0'] = process.argv.slice(2)
		const abstract = new Uint8Array(3 + name.length)
		new DataView(abstract.buffer).setUint16(0, 1, true)
		abstract.set(new TextEncoder().encode(name), 3)
		const loopback = (at: number) => {
			const address = new Uint8Array(16)
			new DataView(address.buffer).setUint16(0, 2, true)
			new DataView(address.buffer).setUint16(2, at, false)
			address.set([127, 0, 0, 1], 4)
			return address
		}
		const outcome = (what: string, result: number) => {
			if (result === 0) return console.log(`${what} reached`)
			const errno = read.i32(libc.symbols.__errno_location()!, 0)
			console.log(`${what} refused: ${names[errno] ?? `errno ${errno}`}`)
		}
		const tried = (what: string, family: number, call: 'bind' | 'connect', address: Uint8Array) =>
			outcome(what, libc.symbols[call](libc.symbols.socket(family, 1, 0), ptr(address), address.length))
		tried('abstract socket', 1, 'connect', abstract)
		tried('loopback port', 2, 'connect', loopback(Number(port)))
		tried('tcp listen', 2, 'bind', loopback(0))
		tried('tcp bind on its own port', 2, 'bind', loopback(Number(own)))
		// A listen with no bind before it, which the kernel binds to a port of
		// its own choosing.
		outcome('unbound listen', libc.symbols.listen(libc.symbols.socket(2, 1, 0), 1))
	EOF
	bun "$scratch/landlock-listen.ts" "$abstract" >"$scratch/landlock-port" &
	listener=$!
	for _ in $(seq 50); do [ -s "$scratch/landlock-port" ] && break; sleep 0.1; done
	port=$(head -1 "$scratch/landlock-port")
	# A port nothing holds, for the probe to bind as the published ports do. The
	# probe binds without listening, so it is free again once each run exits.
	own_port=$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); process.stdout.write(`${s.port}\n`); s.stop(true)')
	{
		echo "=== plain"
		bun "$scratch/landlock-probe.ts" "$abstract" "$port" "$own_port"
		echo "=== under igloo-landlock --connect-tcp 443 --connect-tcp 53"
		"$landlock_bin" --connect-tcp 443 --connect-tcp 53 -- bun "$scratch/landlock-probe.ts" "$abstract" "$port" "$own_port"
		echo "=== under igloo-landlock --connect-tcp <the loopback port>"
		"$landlock_bin" --connect-tcp "$port" -- bun "$scratch/landlock-probe.ts" "$abstract" "$port" "$own_port"
		echo "=== under igloo-landlock --bind-tcp <its own port>"
		"$landlock_bin" --bind-tcp "$own_port" -- bun "$scratch/landlock-probe.ts" "$abstract" "$port" "$own_port"
		echo "=== igloo-landlock --check"
		"$landlock_bin" --check && echo "exit 0"
	} >"$out/artifacts/landlock-reach.txt" 2>&1
	kill "$listener" 2>/dev/null

	# The kernel's own refusals, so that nothing listening — ECONNREFUSED —
	# cannot pass for Landlock.
	expected=$(printf '%s\n' \
		'abstract socket reached' 'loopback port reached' 'tcp listen reached' 'tcp bind on its own port reached' \
		'abstract socket refused: EPERM' 'loopback port refused: EACCES' 'tcp listen refused: EACCES' 'tcp bind on its own port refused: EACCES' \
		'abstract socket refused: EPERM' 'loopback port reached' 'tcp listen refused: EACCES' 'tcp bind on its own port refused: EACCES' \
		'abstract socket refused: EPERM' 'loopback port refused: EACCES' 'tcp listen refused: EACCES' 'tcp bind on its own port reached')
	if [ "$(grep -E '^(abstract socket|loopback port|tcp listen|tcp bind on its own port) ' "$out/artifacts/landlock-reach.txt")" = "$expected" ] &&
		grep -qx 'exit 0' "$out/artifacts/landlock-reach.txt"; then
		verdict PASS landlock-keeps "under igloo-landlock a process reaches no abstract socket of the user's, connects only to the TCP ports named for connecting, and binds only those named for binding"
	else
		verdict FAIL landlock-keeps "read artifacts/landlock-reach.txt"
	fi
	# Recorded rather than judged: a listen that binds no port first gets one
	# the kernel picks, which Landlock does not see. landlock.c lists it as left
	# open; a kernel that closes it shows here as refused.
	verdict NOTE landlock-unbound-listen "under --bind-tcp, $(grep '^unbound listen ' "$out/artifacts/landlock-reach.txt" | tail -1) — artifacts/landlock-reach.txt has it for each run"
fi

# ---------------------------------------------------------- the packaged CLI --
section "the packaged CLI"

# The artifact a host installs, as opposed to the checkout everything else here
# drives. Its whole job is to carry what the devshell otherwise exports, so it
# is checked with the environment stripped: `env -i` plus a system PATH stands
# in for a shell no devshell has touched, which is where an installed igloo
# runs.
started=$EPOCHREALTIME
igloo_pkg=$(nix build --impure --no-link --print-out-paths "$repo#default" 2>"$out/steps/build-igloo.txt")
timed build-igloo "$started"
if [ -n "$igloo_pkg" ] && [ -x "$igloo_pkg/bin/igloo" ]; then
	verdict PASS build-igloo "packages.default builds and produces an executable"
	echo "$igloo_pkg" >"$out/artifacts/igloo-path.txt"

	step packaged-doctor -- env -i \
		HOME="$HOME" \
		PATH="/run/current-system/sw/bin:/usr/bin:/bin" \
		USER="${USER:-}" \
		XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
		"$igloo_pkg/bin/igloo" doctor

	# A store path here is the whole point of packaging: the flake a VM is built
	# from is then read-only, and no guest can change it through a workspace
	# the flake sits in.
	if grep -qE '^  ok +igloo flake +/nix/store/' "$out/steps/packaged-doctor.txt"; then
		verdict PASS packaged-flake-path "the installed CLI builds VMs from a store path, not from a checkout"
	else
		verdict FAIL packaged-flake-path "the installed CLI did not resolve its flake into the store — read steps/packaged-doctor.txt"
	fi

	if grep -qE '^All [0-9]+ checks passed\.$' "$out/steps/packaged-doctor.txt"; then
		verdict PASS packaged-self-sufficient "every prerequisite resolves from the package alone, with the environment stripped"
	else
		verdict FAIL packaged-self-sufficient "a prerequisite did not resolve outside the devshell — read steps/packaged-doctor.txt"
	fi
else
	verdict FAIL build-igloo "packages.default did not build — read steps/build-igloo.txt"
fi

# ------------------------------------------------------------ the user layer --
#
# The checkout's `igloo` carries no user layer, and the installed one does:
# home-manager writes it into that wrapper. The launches below use the
# installed one's, as a launch from it would, and the credential blocks swap in
# scratch layers of their own and put it back.
#
# Not simply the first `igloo` on PATH: a checkout's `bin/igloo` put on PATH, or
# a copy installed some other way, can come ahead of home-manager's and carry
# no layer. So each one on PATH is asked in turn, and the first to report a
# layer from the store is the installed one.
section "the user layer"

candidates=$(type -ap igloo | grep -c .)
real_layer=""
found_at=0
while IFS= read -r candidate; do
	found_at=$((found_at + 1))
	real_layer=$("$candidate" doctor 2>/dev/null | sed -n 's|^  ok  *user layer  *\(/nix/store/.*\)$|\1|p')
	[ -z "$real_layer" ] || break
done < <(type -ap igloo)
if [ -n "$real_layer" ]; then
	verdict PASS installed-user-layer "the installed igloo carries its user layer, from the store — number $found_at of the $candidates igloo on PATH"
elif [ "$candidates" = 0 ]; then
	verdict NOTE installed-user-layer "no igloo on PATH, so the launches below have no user layer"
else
	verdict NOTE installed-user-layer "none of the $candidates igloo on PATH reports a user layer, so the launches below have none"
fi

use_layer() { # use_layer [dir] — a scratch layer, or with none the installed igloo's
	local dir=${1:-$real_layer}
	if [ -n "$dir" ]; then export IGLOO_USER_LAYER="$dir"; else unset IGLOO_USER_LAYER; fi
}
use_layer

# ----------------------------------------------------------------- preflight --
section "preflight"

say ""
step doctor -- "$repo/bin/igloo" doctor
# The verdict is about whether the newer checks report at all, not about
# whether this host passes them — a missing `loginctl` linger is the host's
# business and would otherwise be recorded here as igloo being broken.
if grep -q 'nix build sandbox' "$out/steps/doctor.txt" &&
	grep -q 'virtiofsd' "$out/steps/doctor.txt" &&
	grep -q 'user layer' "$out/steps/doctor.txt" &&
	grep -q 'landlock' "$out/steps/doctor.txt"; then
	verdict PASS doctor-new-checks "doctor reports on the build sandbox, virtiofsd, the user layer and Landlock"
else
	verdict FAIL doctor-new-checks "a new check is missing from the report — read steps/doctor.txt"
fi
verdict NOTE doctor "$(tail -1 "$out/steps/doctor.txt" 2>/dev/null)"

# -------------------------------------------------------------- a real launch --
section "a real launch"

project="$scratch/igloo-verify"
vm_up=""
own_name=""

# Units belonging to VMs the host already had up. A check that counts or picks
# `igloo-*` units counts only what this script's own launches added, since
# another project's VM runs in the same namespace and would otherwise read as
# this one's daemons, or as units a `down` left behind.
foreign_units="$scratch/foreign-units"
systemctl --user list-units --all --plain --no-legend 'igloo-*' | awk '{print $1}' >"$foreign_units"

own_units() { # own_units <glob>
	systemctl --user list-units --all --plain --no-legend "$1" | awk '{print $1}' |
		grep -vxFf "$foreign_units"
}

# The same, as `list-units` prints them, states included.
own_unit_lines() { # own_unit_lines <glob>
	systemctl --user list-units --all --plain --no-legend "$1" |
		awk -v foreign="$(paste -sd " " "$foreign_units")" '
			BEGIN { n = split(foreign, f, " "); for (i = 1; i <= n; i++) skip[f[i]] }
			!($1 in skip)'
}

# What a unit's process is confined to, read off the process itself: its PID
# and seccomp mode, whether each namespace is its own, and whether each path
# named is in its root. /proc/<pid>/root resolves a path inside the process's
# own mount namespace. A path `InaccessiblePaths=` covers is still there, as a
# node no one may search, so what is under it is absent and it is not.
confinement() { # confinement <pid> [<label> <path>]...
	local pid=$1
	shift
	grep -E '^(NSpid|Seccomp):' "/proc/$pid/status"
	for ns in user mnt pid net ipc; do
		if [ "$(readlink "/proc/$pid/ns/$ns")" = "$(readlink "/proc/$$/ns/$ns")" ]; then
			echo "namespace $ns shared"
		else
			echo "namespace $ns private"
		fi
	done
	while [ $# -ge 2 ]; do
		if [ -n "$2" ] && [ -e "/proc/$pid/root$2" ]; then
			echo "$1 present"
		else
			echo "$1 absent"
		fi
		shift 2
	done
}

# Where systemd put the credentials it handed a unit's process.
credentials_of() { # credentials_of <pid>
	tr '\0' '\n' <"/proc/$1/environ" | sed -n 's/^CREDENTIALS_DIRECTORY=//p'
}

# The same for one of an ssh forward's processes, the key its unit was handed
# first among the paths.
forward_confinement() { # forward_confinement <pid> [<label> <path>]...
	local pid=$1
	shift
	confinement "$pid" 'its key' "$(credentials_of "$pid")/identity" "$@"
}

# A stand-in for another VM's runtime directory and broker directory, laid out
# as a launch lays them out: a brokered credential's value, QEMU's control
# socket and the broker's socket. Plain files, since what is checked is whether
# a unit's root holds the path at all.
stage_other_vm() { # stage_other_vm <runtime directory>
	mkdir -p "$1/broker-credentials" "$1-broker"
	echo probe >"$1/broker-credentials/IGLOO_VERIFY_BROKERED"
	: >"$1/control.socket"
	: >"$1-broker/http.sock"
}

if [ -s "$foreign_units" ]; then
	others=$(grep -c '\.slice$' "$foreign_units")
	verdict NOTE other-vms "$others other VMs already up, counted here but never named, and left out of every unit count — the timings shared the host with them"
fi

# A file in the record of the most recent launch. Every `up` opens its own
# directory under <project>/.igloo/logs/ and writes the units' output, its trail
# and its summary in there, with `latest` pointing at the newest — so a path to
# one of them is resolved per launch rather than written out once. This script
# launches the same project many times.
boot_log() { # boot_log <file name>
	printf '%s' "$project/.igloo/logs/latest/$1"
}

# The duration of one named step, in milliseconds.
#
# Read from the trail rather than from the summary: the trail is the half that
# exists for a launch which never concluded, and one line per step is greppable
# without a JSON parser, which this devshell does not carry. Empty output means
# the step is not in the record — which is a finding, not a zero.
phase_ms() { # phase_ms <record directory> <step name>
	sed -n 's/.*"durationMs":\([0-9]*\),"event":"phase","name":"'"$2"'".*/\1/p' \
		"$1/boot.jsonl" 2>/dev/null | tail -1
}

# Keep the current boot's record, under a name that says which launch it was
# rather than when it happened, and add its timings to one table.
keep_boot() { # keep_boot <label>
	local dest="$out/artifacts/logs/$1"
	mkdir -p "$dest"
	cp -r "$project"/.igloo/logs/latest/. "$dest/" 2>/dev/null
	sed -n 's/.*"durationMs":\([0-9]*\),"event":"phase","name":"\([a-z-]*\)".*/'"$1"'\t\2\t\1/p' \
		"$dest/boot.jsonl" 2>/dev/null >>"$out/artifacts/boot-phases.tsv"
}

printf 'launch\tstep\tms\n' >"$out/artifacts/boot-phases.tsv"

# shellcheck disable=SC2329 # run by the EXIT trap below
cleanup() {
	if [ -n "$vm_up" ]; then
		say ""
		say "Stopping the scratch VM…"
		(cd "$project" && "$repo/bin/igloo" down) >>"$out/steps/down.txt" 2>&1
	fi
	[ -z "${model_server:-}" ] || kill "$model_server" 2>/dev/null
	rm -rf "$scratch" "${home_probe:-}" "${other_vm:-}"
	[ -z "${siblings:-}" ] || rm -rf "$siblings"-*
	# On stdin, so that no credential is ever an argument a process listing shows.
	{
		for var in IGLOO_VERIFY_GITHUB_TOKEN IGLOO_VERIFY_OPENROUTER_KEY; do
			[ -z "${!var:-}" ] || printf 'credential=%s\n' "${!var}"
		done
		[ -z "${IGLOO_VERIFY_GITHUB_REPO:-}" ] || printf 'repository=%s\n' "$IGLOO_VERIFY_GITHUB_REPO"
		[ -z "${IGLOO_VERIFY_GITHUB_WRITE_REPO:-}" ] || printf 'repository=%s\n' "$IGLOO_VERIFY_GITHUB_WRITE_REPO"
		# A name that spells one of this machine's addresses, which the address
		# scrub cannot recognise in that spelling.
		[ -z "$own_name" ] || printf 'own-address=%s\n' "$own_name"
	} | "$repo/scripts/redact.sh" "$out"
}
trap cleanup EXIT

# Other VMs beside this script's, for the broker and the forwards to be shown
# none of: one there before any unit here starts, and one made once the broker
# is running. Without XDG_RUNTIME_DIR no VM comes up to be shown them.
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
	siblings="$XDG_RUNTIME_DIR/igloo/igloo-verify-sibling"
	stage_other_vm "$siblings-before"
fi

say ""
say "Launching a scratch VM…"
step init -- "$repo/bin/igloo" init "$project"

if [ -d "$project/.igloo" ]; then
	cd "$project" || exit 1

	# ---- the fallback sandbox, before there is a VM, which is the whole point --
	#
	# A piped script stands in for the interactive shell, so the step's output
	# carries bash complaining that it cannot set the terminal process group.
	# That is the pipe, not the sandbox: with a terminal the shell shares this
	# process's session and job control works.
	section "the fallback sandbox, before there is a VM, which is the whole point"
	cat >"$scratch/fallback-input" <<-'EOF'
		echo "PWD=$PWD"
		echo "HOME=$HOME"
		echo "MARKER=[${IGLOO_VERIFY_MARKER:-unset}]"
		touch /workspace/fallback-workspace /root/fallback-home
		touch /nix/fallback-nope 2>&1 | tail -1
		sleep 7331 &
		exit 7
	EOF

	# Exported so the check can see whether it crosses: the sandbox clears the
	# environment, so a credential in the shell that typed the command stays out.
	export IGLOO_VERIFY_MARKER=present
	step fallback -- bash -c "'$repo/bin/igloo' fallback <'$scratch/fallback-input'"
	fallback_code=$?
	unset IGLOO_VERIFY_MARKER
	keep_boot fallback

	if [ "$fallback_code" = 7 ] &&
		grep -q '^PWD=/workspace$' "$out/steps/fallback.txt" &&
		grep -q '^HOME=/root$' "$out/steps/fallback.txt" &&
		grep -q '^MARKER=\[unset\]$' "$out/steps/fallback.txt" &&
		grep -q 'Read-only file system' "$out/steps/fallback.txt" &&
		[ -e "$project/workspace/fallback-workspace" ] &&
		[ -e "$project/.igloo/home/fallback-home" ] &&
		grep -q '"event":"sandbox"' "$out/artifacts/logs/fallback/boot.jsonl"; then
		verdict PASS fallback "the sandbox mirrors the VM's layout, carries none of the host's environment, and returns the shell's status"
	else
		verdict FAIL fallback "read steps/fallback.txt — the shell exited $fallback_code"
	fi
	rm -f "$project/workspace/fallback-workspace" "$project/.igloo/home/fallback-home"

	# The `sleep` the input leaves in the background dies with the session: the
	# sandbox has no PID namespace, so only its scope reaches it. Checked for the
	# scope by name too, since a session that never opened leaves no `sleep`
	# either.
	if pgrep -f '^sleep 7331$' >/dev/null; then
		pkill -f '^sleep 7331$'
		verdict FAIL fallback-scope "a job left in the background outlived the session — the trail's \`scope\` in artifacts/logs/fallback/boot.jsonl says whether it had one"
	elif grep -q '"scope":"igloo-' "$out/artifacts/logs/fallback/boot.jsonl" 2>/dev/null; then
		verdict PASS fallback-scope "a job left running in the background dies with the session"
	else
		verdict FAIL fallback-scope "the session had no scope — read steps/fallback.txt; \`igloo doctor\` checks the user manager"
	fi

	# The property it exists for: nothing on this path goes through what can be
	# the reason the VM will not start. A policy file `up` refuses outright is
	# the cheapest way to make that concrete, and it refuses before any build.
	printf '{ network = "nonsense"; }\n' >"$project/igloo-policy.nix"
	if step fallback-up-refused -- "$repo/bin/igloo" up; then up_refused=no; else up_refused=yes; fi
	step fallback-broken -- bash -c "'$repo/bin/igloo' fallback <'$scratch/fallback-input'"
	fallback_broken=$?
	rm -f "$project/igloo-policy.nix" "$project/workspace/fallback-workspace" \
		"$project/.igloo/home/fallback-home"

	# The refusal is checked by its message, not only by the status: `up` exits
	# non-zero for plenty of reasons, and the one this pairs with is the policy
	# file. A check that stops short of the reason is not a check of it.
	if [ "$up_refused" = yes ] &&
		grep -q 'not "nonsense"' "$out/steps/fallback-up-refused.txt" &&
		[ "$fallback_broken" = 7 ]; then
		verdict PASS fallback-independent "a configuration that stops \`up\` dead does not stop the fallback"
	elif [ "$up_refused" = no ] ||
		! grep -q 'not "nonsense"' "$out/steps/fallback-up-refused.txt"; then
		verdict FAIL fallback-independent "\`up\` did not refuse the policy file by name — read steps/fallback-up-refused.txt"
	else
		verdict FAIL fallback-independent "the fallback did not open with a broken policy file — read steps/fallback-broken.txt"
	fi

	# ---- evaluation reads nothing on the host it was not given --
	#
	# A policy file and a content layer are both Nix that igloo evaluates as
	# you, before any VM exists. Each tries to read a canary beside the project's
	# private key, and each has to be refused by nix itself — checked by that
	# message, since `up` fails for plenty of other reasons.
	section "evaluation reads nothing on the host it was not given"
	printf 'igloo-verify-canary\n' >"$project/.igloo/verify-canary"

	printf '{ network = builtins.readFile ./.igloo/verify-canary; }\n' >"$project/igloo-policy.nix"
	step eval-policy-confined -- "$repo/bin/igloo" up
	rm -f "$project/igloo-policy.nix"
	if grep -q 'forbidden in restricted mode' "$out/steps/eval-policy-confined.txt"; then
		verdict PASS eval-policy-confined "a policy file cannot read a file beside it"
	else
		verdict FAIL eval-policy-confined "the read was not refused by restricted evaluation — read steps/eval-policy-confined.txt"
	fi

	printf '{ ... }: { environment.etc.canary.text = builtins.readFile ./.igloo/verify-canary; }\n' \
		>"$project/igloo.nix"
	if step eval-content-confined -- "$repo/bin/igloo" up; then
		# It read the file and booted, so stop it before the real launch below
		# finds it running and reports on the wrong guest.
		(cd "$project" && "$repo/bin/igloo" down) >>"$out/steps/eval-content-confined.txt" 2>&1
		verdict FAIL eval-content-confined "a content layer read a file outside what the build may read, and the VM booted"
	elif grep -q 'forbidden in restricted mode' "$out/steps/eval-content-confined.txt"; then
		verdict PASS eval-content-confined "a content layer cannot read the project's own directory outside the workspace"
	else
		verdict FAIL eval-content-confined "the launch failed, but not on restricted evaluation — read steps/eval-content-confined.txt"
	fi
	rm -f "$project/igloo.nix" "$project/.igloo/verify-canary"

	# ---- a replaced runner's share metadata reaches no daemon --
	#
	# The genuine runner with one more share in its metadata, naming a
	# directory nothing else mentions — the half of a replacement that decides
	# what the host serves. A content layer can set `declaredRunner` like any
	# option, so the launch has to go ahead on mkRunner's runner, with the
	# daemons it always starts and none serving that directory.
	section "a replaced runner's share metadata reaches no daemon"
	replaced_canary="$scratch/replaced-runner-canary"
	mkdir -p "$replaced_canary"
	cat >"$project/igloo.nix" <<EOF
{ config, ... }:
{
  microvm.declaredRunner = config.microvm.runner.qemu.overrideAttrs (old: {
    buildCommand = old.buildCommand + ''
      mkdir -p \$out/share/microvm/virtiofs/escape
      echo escape.sock > \$out/share/microvm/virtiofs/escape/socket
      echo $replaced_canary > \$out/share/microvm/virtiofs/escape/source
    '';
  });
}
EOF
	replaced_up=""
	step replaced-runner-up -- "$repo/bin/igloo" up && replaced_up=yes
	# Each daemon, and whether its command line serves the canary — a count,
	# so the scratch path stays out of the record.
	for unit in $(own_units 'igloo-*-virtiofsd-*.service'); do
		printf '%s %s\n' "$unit" \
			"$(systemctl --user show "$unit" -p ExecStart --value | grep -c -- "--shared-dir=$replaced_canary")"
	done >"$out/artifacts/replaced-runner-daemons.txt"
	(cd "$project" && "$repo/bin/igloo" down) >>"$out/steps/replaced-runner-up.txt" 2>&1
	rm -f "$project/igloo.nix"
	if grep -q -- '-virtiofsd-escape\.service\| [1-9]' "$out/artifacts/replaced-runner-daemons.txt"; then
		verdict FAIL replaced-runner-shares "a daemon served the share the replacement named — read artifacts/replaced-runner-daemons.txt"
	elif [ -z "$replaced_up" ]; then
		verdict FAIL replaced-runner-shares "the launch failed — read steps/replaced-runner-up.txt"
	elif [ "$(wc -l <"$out/artifacts/replaced-runner-daemons.txt")" = "3" ]; then
		verdict PASS replaced-runner-shares "a replaced declaredRunner's extra share reached no virtio-fs daemon; the launch ran on mkRunner's runner"
	else
		verdict FAIL replaced-runner-shares "expected the three usual daemons — read artifacts/replaced-runner-daemons.txt"
	fi

	# ---- the build runs nothing that can reach the network --
	#
	# A fixed-output derivation's builder has the network whatever the
	# project's policy says, so a module in the workspace that names one could
	# send anything the evaluation reads anywhere. This one writes a string
	# unique to the run, so no store or cache has it, and `up` has to refuse it
	# by name before building anything. Its builder would succeed if it ran, so
	# an output that is still not valid afterwards is a builder that never ran.
	# Built by hand, as the refusal says to, it is valid, and the same launch
	# goes ahead with it in the runner.
	section "the build runs nothing that can reach the network"
	fod_text="igloo-verify-fod $(date +%s%N)"
	fod_hash=$(printf '%s' "$fod_text" | sha256sum | cut -d' ' -f1)
	cat >"$project/workspace/igloo-verify-fod.nix" <<EOF
{ pkgs, ... }:
{
  environment.etc.igloo-verify-fod.source = pkgs.runCommand "igloo-verify-fod" {
    outputHashMode = "flat";
    outputHashAlgo = "sha256";
    outputHash = "$fod_hash";
  } "printf %s '$fod_text' > \$out";
}
EOF
	printf '{ ... }: { imports = [ ./workspace/igloo-verify-fod.nix ]; }\n' >"$project/igloo.nix"
	printf '{ network = "none"; }\n' >"$project/igloo-policy.nix"
	fod_drv=""
	if step build-refuses-fod -- "$repo/bin/igloo" up; then
		(cd "$project" && "$repo/bin/igloo" down) >>"$out/steps/build-refuses-fod.txt" 2>&1
		verdict FAIL build-refuses-fod "a fixed output from the workspace was built under network = \"none\", and the VM booted"
	else
		fod_drv=$(grep -o '/nix/store/[a-z0-9]*-igloo-verify-fod\.drv' "$out/steps/build-refuses-fod.txt" | head -1)
		if [ -n "$fod_drv" ] && grep -q 'can reach the network' "$out/steps/build-refuses-fod.txt"; then
			verdict PASS build-refuses-fod "a fixed output from the workspace is refused by name under network = \"none\""
		else
			verdict FAIL build-refuses-fod "the launch failed, but not on the check of what it would build — read steps/build-refuses-fod.txt"
		fi
	fi
	if [ -n "$fod_drv" ]; then
		if step fod-never-built -- nix path-info "$fod_drv^*"; then
			verdict FAIL fod-never-built "the refused derivation's output is valid, so its builder ran"
		else
			verdict PASS fod-never-built "the refused derivation's builder never ran"
		fi

		if step fod-built-by-hand -- nix build --no-link "$fod_drv^*" &&
			step build-reviewed-fod -- "$repo/bin/igloo" up; then
			vm_up=yes
			# Listed whole before it is searched: `grep -q` stops reading at its
			# first match, and a writer still writing then fails on the closed
			# pipe, which pipefail makes the condition's status. How far nix has
			# written by then depends on where the derivation sorts.
			fod_closure=$(nix path-info -r "$project/.igloo/runners/current" 2>>"$out/steps/build-reviewed-fod.txt")
			if grep -q -- '-igloo-verify-fod$' <<<"$fod_closure"; then
				verdict PASS build-reviewed-fod "built by hand, the derivation is valid, and the launch goes ahead with it"
			else
				verdict FAIL build-reviewed-fod "the launch went ahead without the derivation in its runner — read steps/build-reviewed-fod.txt"
			fi
			step down-reviewed-fod -- "$repo/bin/igloo" down
			vm_up=""
		else
			verdict FAIL build-reviewed-fod "built by hand, the derivation still did not launch — read steps/fod-built-by-hand.txt and steps/build-reviewed-fod.txt"
		fi
	fi
	rm -f "$project/igloo.nix" "$project/igloo-policy.nix" "$project/workspace/igloo-verify-fod.nix"

	# ---- the first launch --
	#
	# With no project layer: the units it starts, what the guest sees of its
	# shares and the store, the fallback beside a running VM, and what `down`
	# leaves.
	section "the first launch"
	if step up -- "$repo/bin/igloo" up; then
		vm_up=yes
		verdict PASS up "the VM boots with the daemons igloo starts itself"
	else
		verdict FAIL up "the VM did not come up — steps/up.txt, and the logs copied below"
	fi

	# Whatever happened, take the units and the logs. A failed launch is the
	# case where these matter most.
	step units -- own_unit_lines 'igloo-*'
	{
		for unit in $(own_units 'igloo-*.service'); do
			echo "=== $unit"
			# The program each unit execs, and how many store paths its namespace
			# binds — not the argument vector, which names every package the guest
			# has. The program is the `path=` systemd writes first; an argument
			# can contain `path=` too (virtiofsd's `--socket-path=`), so the match
			# is anchored rather than greedy.
			exec_start=$(systemctl --user show "$unit" -p ExecStart --value)
			echo "ExecStart path=$(sed -n 's/^{ path=\([^ ;]*\).*/\1/p' <<<"$exec_start" | head -1)"
			# igloo-store-view reads the paths it binds from a file, its first
			# argument, so the count is that file's.
			paths_file=$(sed -n 's/.* argv\[\]=[^ ]*igloo-store-view \([^ ;]*\) .*/\1/p' <<<"$exec_start" | head -1)
			if [ -n "$paths_file" ]; then
				echo "store paths bound: $(wc -l <"$paths_file")"
			fi
			systemctl --user show "$unit" -p ActiveState -p SubState -p Slice
			echo
		done
	} >"$out/artifacts/unit-properties.txt" 2>&1
	keep_boot up

	# The launch's own record. A launch that failed leaves one too, so this runs
	# whatever happened — and the two halves are checked separately because they
	# fail separately: the trail is appended to as the launch proceeds, the
	# summary is written once at the end.
	if [ ! -e "$project/.igloo/logs/latest" ]; then
		verdict FAIL boot-record "no boot record for this launch — \`latest\` resolves to nothing"
	elif no_evidence "$out/artifacts/logs/up/boot.jsonl"; then
		verdict FAIL boot-record "the boot record has no trail — read artifacts/logs/up/"
	elif [ ! -s "$out/artifacts/logs/up/boot.json" ]; then
		verdict FAIL boot-record "the launch concluded without a summary — read artifacts/logs/up/"
	elif [ -z "$(phase_ms "$out/artifacts/logs/up" build)" ]; then
		verdict FAIL boot-record "the trail carries no \`build\` step — read artifacts/logs/up/boot.jsonl"
	elif [ -n "$vm_up" ] && [ ! -s "$out/artifacts/logs/up/serial.log" ]; then
		verdict FAIL boot-record "the guest's console did not land in the boot's own directory"
	else
		verdict PASS boot-record "the launch left a trail, a summary, and the units' logs in one directory"
	fi

	# One unit per share, and only the store's under igloo-store-view — with
	# nothing on the launch path under bubblewrap, which only the fallback runs.
	# All of it is visible in the program each unit execs.
	# Every claim below reads the same file, so an empty one is "no evidence"
	# rather than three passes for a VM that never started.
	if no_evidence "$out/artifacts/unit-properties.txt"; then
		verdict NOTE unit-properties "no units to inspect; the launch did not get that far"
	else
		daemons=$(grep -c '^=== .*virtiofsd.*\.service' "$out/artifacts/unit-properties.txt")
		if [ "$daemons" -ge 2 ]; then
			verdict PASS per-share-units "$daemons virtio-fs units, one per share"
		else
			verdict FAIL per-share-units "expected a unit per share, found $daemons"
		fi

		viewed=$(grep -c '^ExecStart path=.*igloo-store-view' "$out/artifacts/unit-properties.txt")
		wrapped=$(grep -c '^ExecStart path=.*bwrap' "$out/artifacts/unit-properties.txt")
		if [ "$viewed" = "1" ] && [ "$wrapped" = "0" ]; then
			verdict PASS only-store-viewed "exactly one daemon runs under igloo-store-view, and none under bubblewrap"
		else
			verdict FAIL only-store-viewed "$viewed units exec igloo-store-view and $wrapped exec bwrap; expected the store's alone, under igloo-store-view"
		fi

		# The program, not the argument vector: virtiofsd-run is a member of the
		# closure the store daemon binds into its namespace, as it has to be, and
		# is never run — so its name in the arguments would be a false failure.
		if grep -q 'path=[^ ]*\(supervisord\|virtiofsd-run\)' "$out/artifacts/unit-properties.txt"; then
			verdict FAIL no-generated-script "a unit still executes the runner's generated script"
		else
			verdict PASS no-generated-script "nothing the host runs comes from virtiofsd-run"
		fi

		# virtiofsd sandboxes itself: the worker it forks, which is what serves
		# the guest's requests, has user, mount, PID and network namespaces of
		# its own, a seccomp filter, and its share for a root. Read off each
		# running worker rather than off the flags that ask for it.
		{
			for unit in $(own_units 'igloo-*-virtiofsd-*.service'); do
				main=$(systemctl --user show -P MainPID "$unit")
				for worker in $(pgrep -P "$main"); do
					private=0
					for ns in user mnt pid net; do
						if [ "$(readlink "/proc/$worker/ns/$ns")" != "$(readlink "/proc/$$/ns/$ns")" ]; then
							private=$((private + 1))
						fi
					done
					seccomp=$(sed -n 's/^Seccomp:[[:space:]]*//p' "/proc/$worker/status")
					home=$([ -e "/proc/$worker/root$HOME" ] && echo reachable || echo absent)
					echo "worker private=$private seccomp=$seccomp home=$home"
				done
			done
		} >"$out/artifacts/virtiofsd-sandbox.txt" 2>&1
		workers=$(grep -c '^worker ' "$out/artifacts/virtiofsd-sandbox.txt")
		sandboxed=$(grep -cx 'worker private=4 seccomp=2 home=absent' "$out/artifacts/virtiofsd-sandbox.txt")
		if [ "$workers" = "$daemons" ] && [ "$sandboxed" = "$daemons" ]; then
			verdict PASS virtiofsd-sandboxed "each of the $daemons virtio-fs workers has user, mount, PID and network namespaces of its own, a seccomp filter, and no way to the home directory"
		else
			verdict FAIL virtiofsd-sandboxed "$sandboxed of $daemons virtio-fs daemons have a sandboxed worker ($workers workers found) — read artifacts/virtiofsd-sandbox.txt"
		fi
	fi

	# Inside the guest. There is no `igloo exec`, so this rebuilds the same ssh
	# invocation the CLI makes; if that drifts, this section is what to fix.
	#
	# One string per call, not an argument vector: ssh joins its arguments with
	# spaces and hands the result to the guest's login shell, which parses it
	# once more. An `sh -c 'a | b'` here loses its quoting on the way and
	# silently runs something else.
	guest() { # guest <one shell command>
		ssh -F /dev/null \
			-o "ProxyCommand=$IGLOO_SSH_PROXY %h %p" -o ProxyUseFdpass=yes \
			-o User=root -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o LogLevel=ERROR -o BatchMode=yes \
			-i "$project/.igloo/ssh/id" "vsock/$cid" "$1"
	}
	cid=$(sed -n 's/.*vsockCid = \([0-9]*\);.*/\1/p' "$project/.igloo/runner/flake.nix" | head -1)
	if [ -n "$vm_up" ] && [ -n "$cid" ]; then
		{
			echo "=== findmnt -t virtiofs"
			guest 'findmnt -t virtiofs'
			echo
			echo "=== store paths visible in the guest"
			guest 'ls /nix/store | wc -l'
			echo "=== store paths in the reference runner's closure (host)"
			wc -l <"$out/artifacts/closure.txt"
			echo
			echo "=== /workspace"
			guest 'ls -a /workspace; touch /workspace/.igloo-verify-write && echo WRITE-OK'
			echo "=== /root"
			guest 'ls -a /root'
			echo
			echo "=== nproc / memory"
			guest 'nproc; free -m | head -2'
		} >"$out/artifacts/guest.txt" 2>&1

		if grep -q 'WRITE-OK' "$out/artifacts/guest.txt"; then
			verdict PASS guest-shares "all shares mounted, and the workspace is writable"
		else
			verdict FAIL guest-shares "the guest could not use its shares — read artifacts/guest.txt"
		fi

		# The store view's whole claim: the guest sees the closure of the runner it
		# booted from, every path of it and nothing else. Compared against that
		# runner's closure rather than the reference runner's, which carries no
		# user or project layer. The two lists name every package the guest has,
		# so they stay in the scratch directory and only the counts leave it.
		guest 'ls /nix/store' 2>/dev/null | sort >"$scratch/store-guest"
		nix path-info -r "$project/.igloo/runners/current" 2>/dev/null | sed 's|^/nix/store/||' | sort >"$scratch/store-served"
		served=$(grep -c . "$scratch/store-served")
		missing=$(comm -13 "$scratch/store-guest" "$scratch/store-served" | grep -c .)
		extra=$(comm -23 "$scratch/store-guest" "$scratch/store-served" | grep -c .)
		printf '\n=== store paths: %s in the closure of the runner it booted; %s of them missing in the guest, %s there beyond them\n' \
			"$served" "$missing" "$extra" >>"$out/artifacts/guest.txt"
		if [ "$served" -gt 0 ] && [ "$missing" = 0 ] && [ "$extra" = 0 ]; then
			verdict PASS store-restricted "the guest sees the $served paths of its runner's closure and nothing else"
		else
			verdict FAIL store-restricted "of a closure of $served paths the guest is missing $missing and has $extra beyond it — read artifacts/guest.txt"
		fi

		# The guest's own read-only mount is not the boundary: guest root can mount
		# the share again, read-write, as it does at boot before stacking a
		# read-only mount on top. A second mount and one write, which the daemon
		# has to refuse — a success lands in a tmpfs held in host memory.
		probe=$(guest "mkdir -p /run/igloo-store-probe && mount -t virtiofs ro-store /run/igloo-store-probe && { touch /run/igloo-store-probe/.igloo-write-probe && echo STORE-WRITABLE; rm -f /run/igloo-store-probe/.igloo-write-probe; umount /run/igloo-store-probe; }" 2>&1)
		printf '\n=== a write through a second mount of the store share\n%s\n' "$probe" >>"$out/artifacts/guest.txt"
		if printf '%s' "$probe" | grep -q 'STORE-WRITABLE'; then
			verdict FAIL store-readonly "guest root wrote into the store share through a mount of its own — read artifacts/guest.txt"
		elif printf '%s' "$probe" | grep -q 'Read-only file system'; then
			verdict PASS store-readonly "the store share refuses the guest's writes on the host's side, whatever the guest mounts"
		else
			verdict FAIL store-readonly "the probe did not get as far as a write — read artifacts/guest.txt"
		fi

		# Every owner in the store, the store directory itself and three levels
		# down — deep enough to take in files like the `ssh_config.d` include,
		# which OpenSSH refuses when root does not own it — so one line of
		# output is the whole claim. The daemon reads root as the overflow id,
		# 65534, and what the store view made for itself — the directory, a
		# top-level symlink — as the invoking user; it translates both to 0,
		# and without that this is what the guest sees.
		owners=$(guest "find /nix/store -maxdepth 3 -printf '%U:%G\n' | sort -u" 2>&1)
		{
			printf '\n=== owners in the store, as the guest sees them\n%s\n' "$owners"
			echo "=== entries not owned by root, the first twenty"
			guest "find /nix/store -maxdepth 3 ! -uid 0 -printf '%U:%G %y %p\n' | head -20"
		} >>"$out/artifacts/guest.txt" 2>&1
		if [ "$owners" = "0:0" ]; then
			verdict PASS store-owner "the guest sees the store as root's, as the host has it"
		else
			verdict FAIL store-owner "the guest sees the store owned by $(printf '%s' "$owners" | tr '\n' ' ')— read artifacts/guest.txt"
		fi

	fi

	# With a runner built, the guest's profile comes first on the fallback's
	# PATH: the agents are declared for the guest and are not on the host.
	if [ -n "$vm_up" ]; then
		step fallback-guest -- bash -c "echo 'command -v bash' | '$repo/bin/igloo' fallback"
		if grep -q '^/nix/store/[^/]*-system-path/bin/bash$' "$out/steps/fallback-guest.txt"; then
			verdict PASS fallback-guest "with a runner built, the fallback's PATH starts with the guest's packages"
		else
			verdict FAIL fallback-guest "bash did not come from the guest's profile — read steps/fallback-guest.txt"
		fi
	fi

	# This project's row only: `ls` lists every VM on the host, and another
	# project's name and path are not this run's to record.
	own_ls() { "$repo/bin/igloo" ls --verbose | awk -v label="$(basename "$project")" 'NR == 1 || index($0, label)'; }
	step ls -- own_ls

	if [ -n "$vm_up" ]; then
		step down -- "$repo/bin/igloo" down
		vm_up=""
		left=$(own_units 'igloo-*' | grep -c .)
		if [ "$left" = "0" ]; then
			verdict PASS teardown "down leaves no units behind"
		else
			verdict FAIL teardown "$left units survived down — read steps/units.txt"
		fi
		# The teardown above holds for a cgroup kill as well. This is the
		# power event: sent over QMP only to the process that is QEMU's unit's
		# main process, which under the unit's PID namespace has to be the one
		# listening, and obeyed by the guest within the wait.
		if grep -q 'killing its cgroup' "$out/steps/down.txt"; then
			verdict FAIL down-powers-off "down fell back to killing the cgroup — read steps/down.txt for why"
		elif grep -q 'powering off' "$out/steps/down.txt"; then
			verdict PASS down-powers-off "down sent the power event to QEMU's own process, and the guest went down on its own"
		else
			verdict FAIL down-powers-off "down said nothing about powering off — read steps/down.txt"
		fi

		# ----------------------------------------------------- the warm build --
		#
		# The same project, unchanged, launched a second time. Every derivation
		# the first launch built is in the store and the generated flake is
		# byte-identical, so the `evaluate`, `plan` and `build` steps are what
		# a launch costs with nothing left to realise. Most of it is evaluating
		# the runner's `nixosSystem`, which is the whole of what a build cache
		# would skip.
		#
		# Recorded rather than judged. The number is the case for that cache or
		# the case against it, and it is not one this script should decide.
		section "the warm build"
		say ""
		say "Launching the same project again, to price the build…"
		if step up-warm -- "$repo/bin/igloo" up; then
			vm_up=yes
			verdict PASS up-warm "an unchanged project launches again from the same generated flake"
		else
			verdict FAIL up-warm "the second launch failed — read steps/up-warm.txt"
		fi
		keep_boot up-warm

		# The first launch is not a cold build — the reference runner above put
		# most of the closure in the store — so the pair is "a build with
		# derivations to realise" against "a build with none", not first-ever
		# against repeat.
		first_evaluate=$(phase_ms "$out/artifacts/logs/up" evaluate)
		first_plan=$(phase_ms "$out/artifacts/logs/up" plan)
		first_build=$(phase_ms "$out/artifacts/logs/up" build)
		warm_evaluate=$(phase_ms "$out/artifacts/logs/up-warm" evaluate)
		warm_plan=$(phase_ms "$out/artifacts/logs/up-warm" plan)
		warm_build=$(phase_ms "$out/artifacts/logs/up-warm" build)
		# The denominator: a build worth caching is one that is a large share of
		# the launch, and the share is what the two numbers together say.
		warm_total=$(sed -n 's/.*"durationMs":\([0-9]*\),"event":"outcome".*/\1/p' \
			"$out/artifacts/logs/up-warm/boot.jsonl" 2>/dev/null | tail -1)
		if [ -n "$first_evaluate" ] && [ -n "$first_plan" ] && [ -n "$first_build" ] &&
			[ -n "$warm_evaluate" ] && [ -n "$warm_plan" ] && [ -n "$warm_build" ] && [ -n "$warm_total" ]; then
			verdict NOTE warm-build "evaluate/plan/build: ${first_evaluate}/${first_plan}/${first_build}ms on the first launch, ${warm_evaluate}/${warm_plan}/${warm_build}ms with nothing left to realise, in a ${warm_total}ms launch — artifacts/boot-phases.tsv has every step of both"
		else
			verdict NOTE warm-build "a timing was missing, so the build is unpriced — read artifacts/boot-phases.tsv"
		fi

		if [ -n "$vm_up" ]; then
			step down-warm -- "$repo/bin/igloo" down
			vm_up=""
		fi
	fi

	# ---------------------------------------------- publishing a guest port --
	#
	# End to end, with a listener built from what the guest already has: a
	# systemd socket unit and `echo`. Nothing is added to the closure, and the
	# path under test is the whole of it — the host's loopback, the forward over
	# the management channel, the guest's sshd, and a server bound to the
	# guest's *own* loopback, which is the part that would need 0.0.0.0 in a
	# container and does not here.
	section "publishing a guest port"
	say ""
	say "Publishing a guest port…"
	published=${IGLOO_VERIFY_PORT:-45080}
	cat >"$project/igloo.nix" <<'EOF'
{ pkgs, ... }:
{
  systemd.sockets.igloo-verify-echo = {
    wantedBy = [ "sockets.target" ];
    socketConfig = {
      ListenStream = "127.0.0.1:8000";
      Accept = true;
    };
  };
  systemd.services."igloo-verify-echo@" = {
    serviceConfig = {
      ExecStart = "${pkgs.coreutils}/bin/echo igloo-published-port-works";
      StandardInput = "socket";
      StandardOutput = "socket";
    };
  };
}
EOF
	cat >"$project/igloo-policy.nix" <<EOF
{ ports = [ { guest = 8000; host = $published; } ]; }
EOF
	if step up-ports -- "$repo/bin/igloo" up; then
		vm_up=yes
		verdict PASS up-ports "a VM that publishes a port boots"
	else
		verdict FAIL up-ports "it did not come up — read steps/up-ports.txt"
	fi
	keep_boot up-ports

	if [ -n "$vm_up" ]; then
		{
			echo "=== what the launch said it published"
			grep -i published "$out/steps/up-ports.txt" || echo "(the launch said nothing)"
			echo
			echo "=== the host end, read from the host rather than from inside"
			(exec 3<>"/dev/tcp/127.0.0.1/$published" && timeout 5 cat <&3) ||
				echo "(nothing accepted on 127.0.0.1:$published)"
			echo
			echo "=== and the unit carrying it"
			own_unit_lines 'igloo-*-ports.service'
		} >"$out/artifacts/ports.txt" 2>&1

		if grep -q 'igloo-published-port-works' "$out/artifacts/ports.txt"; then
			verdict PASS ports-reachable "a guest server on the guest's own loopback answers on the host's"
		else
			verdict FAIL ports-reachable "nothing came back through the published port — read artifacts/ports.txt"
		fi

		# The forward is an ssh client of a server the guest controls, confined
		# as the tether is but on the host's network, since it listens on the
		# host's loopback. What that network reaches is narrowed by
		# igloo-landlock, which its ExecStart shows it runs under: allowed to
		# bind the published port, and to connect to nothing. Nothing the guest
		# sends makes the client bind or connect anywhere else, so what the
		# helper refuses is shown by landlock-keeps rather than here.
		ports_unit=$(own_units 'igloo-*-ports.service' | head -1)
		ports_id=${ports_unit#igloo-}
		ports_id=${ports_id%-ports.service}
		{
			echo "restriction: $(systemctl --user show -p ExecStart "$ports_unit" |
				grep -oE 'igloo-landlock( --[a-z-]+ [0-9]+)* --')"
			forward_confinement "$(systemctl --user show -P MainPID "$ports_unit")" \
				'the home directory' "$HOME" \
				"the project's key" "$project/.igloo/ssh/id" \
				"the VM's runtime directory" "$XDG_RUNTIME_DIR/igloo/$ports_id" \
				"another VM's runtime directory" "$siblings-before" \
				"the user manager's socket" "$XDG_RUNTIME_DIR/systemd/private"
			for hidden in "$siblings-before" "$XDG_RUNTIME_DIR/systemd/private"; do
				[ -e "$hidden" ] && echo "on the host: ${hidden##*/}"
			done
		} >"$out/artifacts/ports-confinement.txt" 2>&1
		expected=$(printf '%s\n' 'its key present' 'the home directory absent' \
			"the project's key absent" "the VM's runtime directory absent" \
			"another VM's runtime directory absent" "the user manager's socket absent")
		if grep -q '^NSpid:.*[[:space:]]1$' "$out/artifacts/ports-confinement.txt" &&
			grep -q '^Seccomp:[[:space:]]*2$' "$out/artifacts/ports-confinement.txt" &&
			[ "$(grep -c '^namespace .* private$' "$out/artifacts/ports-confinement.txt")" = 4 ] &&
			grep -qx 'namespace net shared' "$out/artifacts/ports-confinement.txt" &&
			[ "$(grep -E ' (present|absent)$' "$out/artifacts/ports-confinement.txt")" = "$expected" ] &&
			[ "$(grep -c '^on the host: ' "$out/artifacts/ports-confinement.txt")" = 2 ]; then
			verdict PASS ports-confined "the published port's forward runs as PID 1 in user, mount, PID and IPC namespaces of its own under seccomp, on the host's network, holding its key, and finds the home directory, the VM's runtime directory, another VM's and the user manager's socket missing"
		else
			verdict FAIL ports-confined "read artifacts/ports-confinement.txt"
		fi
		if grep -qx "restriction: igloo-landlock --bind-tcp $published --" "$out/artifacts/ports-confinement.txt"; then
			verdict PASS ports-under-landlock "the published port's forward runs under igloo-landlock, allowed to bind port $published alone and to connect to nothing"
		else
			verdict FAIL ports-under-landlock "the forward's ExecStart does not go through igloo-landlock with that port alone — read artifacts/ports-confinement.txt"
		fi

		# ------------------------------------------- and the drift report --
		#
		# `up` against a running VM rebuilds nothing by design, so an edited
		# layer takes effect at the next `down` and not before. The claim here
		# is that it says so, and names the file — the silent version of this
		# is a guest running configuration its author has already changed.
		section "and the drift report"
		printf '\n# touched by host-verify\n' >>"$project/igloo.nix"
		step up-drift -- "$repo/bin/igloo" up
		if grep -q 'launched before' "$out/steps/up-drift.txt" &&
			grep -q "$project/igloo.nix" "$out/steps/up-drift.txt"; then
			verdict PASS launch-drift "a launch against a running VM names the layer that changed since it started"
		else
			verdict FAIL launch-drift "the changed layer was not reported — read steps/up-drift.txt"
		fi

		# igloo's own Nix files reach the runner through its flake rather than
		# a layer, and most of them are not `flake.nix`. A copy of the flake
		# with every file under nix/ touched stands in for an upgrade that
		# changed them, and each has to be named. `up` against a running VM
		# builds nothing, so the copy needs only what the record reads.
		igloo_edited="$scratch/igloo-edited"
		mkdir -p "$igloo_edited"
		cp -R "$repo/flake.nix" "$repo/flake.lock" "$repo/nix" "$igloo_edited/"
		nix_files=()
		while IFS= read -r -d '' file; do
			printf '\n# touched by host-verify\n' >>"$file"
			nix_files+=("${file#"$igloo_edited"/}")
		done < <(find "$igloo_edited/nix" -type f -print0)
		step up-drift-igloo -- env IGLOO_FLAKE="$igloo_edited" "$repo/bin/igloo" up
		unnamed=0
		for file in "${nix_files[@]}"; do
			grep -qF "igloo's $file" "$out/steps/up-drift-igloo.txt" || unnamed=$((unnamed + 1))
		done
		if [ ${#nix_files[@]} -gt 0 ] && [ "$unnamed" = 0 ]; then
			verdict PASS launch-drift-igloo "a launch against a running VM names each of the ${#nix_files[@]} files under igloo's nix/ that changed since it started"
		else
			verdict FAIL launch-drift-igloo "$unnamed of the ${#nix_files[@]} files under igloo's nix/ that changed went unreported — read steps/up-drift-igloo.txt"
		fi

		step down-ports -- "$repo/bin/igloo" down
		vm_up=""
	fi
	# Scoped to these checks: the blocks below declare their own policy, and a
	# content module left behind would be in their builds too.
	rm -f "$project/igloo.nix" "$project/igloo-policy.nix"

	# ------------------------------------------------------ delivered credentials --
	#
	# A second launch of the same project, with a scratch user layer. That is
	# not tidiness: the user layer is where credentials are declared, and the
	# real one is home-manager's, in the store.
	section "delivered credentials"
	say ""
	say "Launching again, with two credentials…"

	creds_config="$scratch/config"
	mkdir -p "$creds_config/igloo"
	printf 'plain-file-value' >"$creds_config/from-file"
	cat >"$creds_config/print-secret" <<'SRC'
#!/usr/bin/env bash
printf 'from-a-command\n'
SRC
	chmod +x "$creds_config/print-secret"
	cat >"$creds_config/igloo/igloo-policy.nix" <<EOF
{
  secrets = {
    IGLOO_VERIFY_FILE = {
      source = { file = "$creds_config/from-file"; };
      mode = "deliver";
      projects = [ "$project" ];
    };
  };
}
EOF
	# One credential from each layer: the user layer's reaches the project by
	# listing it, and the project declares its own.
	cat >"$project/igloo-policy.nix" <<EOF
{
  secrets.IGLOO_VERIFY_CMD = {
    source = { command = [ "$creds_config/print-secret" ]; };
    mode = "deliver";
  };
}
EOF

	use_layer "$creds_config/igloo"
	if step up-credentials -- "$repo/bin/igloo" up; then
		vm_up=yes
		verdict PASS up-credentials "a VM with delivered credentials boots"
	else
		verdict FAIL up-credentials "it did not boot — read steps/up-credentials.txt"
	fi
	keep_boot up-credentials

	if [ -n "$vm_up" ]; then
		{
			# The whole chain, so a failure says which link broke rather than
			# only that the credential is missing. fw_cfg is the design's one
			# inferred claim: QEMU carries the file, the guest kernel exposes it
			# under /sys/firmware, and systemd lays it out under /run/credentials.
			echo "=== QEMU's own command line (credential arguments only)"
			qemu_unit=$(own_units 'igloo-*-qemu.service' | head -1)
			qemu_pid=$(systemctl --user show "$qemu_unit" -p MainPID --value 2>/dev/null)
			if [ -n "$qemu_pid" ] && [ -r "/proc/$qemu_pid/cmdline" ]; then
				tr '\0' '\n' <"/proc/$qemu_pid/cmdline" | grep -B1 'io.systemd.credentials'
			else
				echo "(could not read QEMU's command line; not fatal)"
			fi
			echo
			echo "=== does the guest kernel expose fw_cfg at all"
			guest 'ls /sys/firmware/qemu_fw_cfg/by_name/ 2>&1 | head -5'
			echo
			echo "=== and the credentials under it"
			guest 'ls /sys/firmware/qemu_fw_cfg/by_name/opt/io.systemd.credentials/ 2>&1'
			echo
			echo "=== what systemd laid out"
			guest 'ls -la /run/credentials/@system/ 2>&1'
			echo
			echo "=== the values, which is the point"
			guest 'cat /run/credentials/@system/IGLOO_VERIFY_FILE; echo; cat /run/credentials/@system/IGLOO_VERIFY_CMD'
			echo
			echo "=== where they live: tmpfs, or something that persists?"
			guest 'findmnt -T /run/credentials/@system'
		} >"$out/artifacts/credentials.txt" 2>&1

		if grep -q 'plain-file-value' "$out/artifacts/credentials.txt" &&
			grep -q 'from-a-command' "$out/artifacts/credentials.txt"; then
			verdict PASS credentials-delivered "both credentials reached /run/credentials/@system, one from each layer"
		else
			verdict FAIL credentials-delivered "they did not arrive — artifacts/credentials.txt says which stage broke"
		fi

		# The trailing newline convention: the command printed one, and it is
		# the terminator rather than part of the secret.
		if guest 'test "$(cat /run/credentials/@system/IGLOO_VERIFY_CMD | wc -c)" = 14' 2>/dev/null; then
			verdict PASS credentials-newline "one trailing newline was dropped, and no more"
		else
			verdict FAIL credentials-newline "the delivered value is not the expected 14 bytes"
		fi

		# Host side: on the runtime tmpfs, owner-only, and gone after `down`.
		# Located rather than reconstructed, so this also checks they are where
		# the design says they are and not somewhere under the project.
		found=$(find "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/igloo" -name IGLOO_VERIFY_FILE 2>/dev/null | head -1)
		if [ -z "$found" ]; then
			# Without this the removal check below would pass by finding nothing
			# in a directory that never existed.
			verdict FAIL credentials-host-mode "no host-side credential file under XDG_RUNTIME_DIR"
			runtime_creds=""
		else
			runtime_creds=$(dirname "$found")
			{
				# Modes and names: `ls -l` would add the owner, which is the user's name.
				echo "=== host-side credential files"
				(cd "$runtime_creds" && stat -c '%A %n' -- *) 2>&1
				echo "=== the filesystem holding them"
				findmnt -T "$runtime_creds" 2>&1
			} >"$out/artifacts/credentials-host.txt" 2>&1
			if grep -qE '^-rw-------.* IGLOO_VERIFY_FILE' "$out/artifacts/credentials-host.txt"; then
				verdict PASS credentials-host-mode "the host-side values are readable only by their owner"
			else
				verdict FAIL credentials-host-mode "check artifacts/credentials-host.txt"
			fi
		fi

		step down-credentials -- "$repo/bin/igloo" down
		vm_up=""
		if [ -z "$runtime_creds" ]; then
			verdict NOTE credentials-removed "nothing was written, so there was nothing to remove"
		elif [ -e "$runtime_creds/IGLOO_VERIFY_FILE" ]; then
			verdict FAIL credentials-removed "the values outlived the VM they were fetched for"
		else
			verdict PASS credentials-removed "down takes the host-side values with it"
		fi
	fi
	use_layer

	# ------------------------------------------------------ brokered credentials --
	#
	# Another launch, with a credential the guest must never hold: the broker
	# and the tether as an unprivileged user manager runs them, reached from a
	# real guest over vsock, which is the whole path and one no test assembles.
	section "brokered credentials"
	say ""
	say "Launching again, with a brokered credential…"

	broker_config="$scratch/broker-config"
	mkdir -p "$broker_config/igloo"
	printf 'brokered-value-never-in-the-guest' >"$broker_config/from-file"

	# A stand-in for a model server on this machine's loopback, at a port nothing
	# else holds. It records every request that reaches it, so one the broker
	# refused shows as absent.
	cat >"$scratch/model-server.ts" <<-'EOF'
		// model-server <log> — listen on a loopback port, print it, and answer as an
		// OpenAI-compatible server would: its model listing, and a 404 for anything
		// else. Each request's method, path and Authorization go to <log>.
		import { appendFileSync } from 'node:fs'
		const server = Bun.serve({
			fetch(request) {
				const { pathname } = new URL(request.url)
				const authorization = request.headers.get('authorization') ?? '-'
				appendFileSync(process.argv[2] ?? '/dev/null', `${request.method} ${pathname} ${authorization}\n`)
				return pathname === '/v1/models'
					? Response.json({ data: [{ id: 'igloo-verify-model', object: 'model' }], object: 'list' })
					: new Response('404 page not found\n', { status: 404 })
			},
			hostname: '127.0.0.1',
			port: 0,
		})
		process.stdout.write(`${server.port}\n`)
	EOF
	bun "$scratch/model-server.ts" "$scratch/model-server.log" >"$scratch/model-server-port" &
	model_server=$!
	for _ in $(seq 50); do [ -s "$scratch/model-server-port" ] && break; sleep 0.1; done
	model_port=$(head -1 "$scratch/model-server-port")
	cat >"$broker_config/igloo/igloo-policy.nix" <<EOF
{
  secrets = {
    IGLOO_VERIFY_BROKERED = {
      source = { file = "$broker_config/from-file"; };
      mode = "broker";
      profile = "github";
      repos = [ "git/git" ];
      write = [ "git/git-scm.com" ];
      projects = [ "$project" ];
    };
    IGLOO_VERIFY_INFERENCE = {
      source = { file = "$broker_config/from-file"; };
      mode = "broker";
      profile = "anthropic-messages";
      projects = [ "$project" ];
    };
  };
  modelServers.igloo-verify = {
    port = $model_port;
    projects = [ "$project" ];
  };
}
EOF
	# Restricted with no tunnel: the least a VM with grants can reach. The
	# broker is not told the mode, so what passes it here passes it under
	# internet too.
	printf '{ network = "restricted"; }\n' >"$project/igloo-policy.nix"
	# The core is deflated, so the guest has no HTTPS client to prove the
	# broker's TLS names and the tunnel with. A content layer is how a project
	# adds one, which makes this both the fixture and a second use of the
	# content plane — and the module sits in the workspace, imported from the
	# project layer, because that is the one place outside the layers a
	# confined evaluation may read from.
	cat >"$project/workspace/igloo-verify-curl.nix" <<'EOF'
{ pkgs, ... }: { environment.systemPackages = [ pkgs.curl ]; }
EOF
	cat >"$project/igloo.nix" <<'EOF'
{ ... }: { imports = [ ./workspace/igloo-verify-curl.nix ]; }
EOF

	use_layer "$broker_config/igloo"
	if step up-broker -- "$repo/bin/igloo" up; then
		vm_up=yes
		verdict PASS up-broker "a VM with a brokered credential boots, and both extra units start"
	else
		verdict FAIL up-broker "it did not come up — read steps/up-broker.txt, then artifacts/logs/up-broker/"
	fi

	# Taken whatever happened: a broker that refused to start is exactly the case
	# these logs explain, and the unit properties say which option systemd
	# rejected.
	broker_unit=$(own_units 'igloo-*-broker.service' | head -1)
	tether_unit=$(own_units 'igloo-*-tether.service' | head -1)
	{
		echo "=== broker unit: ${broker_unit:-<none>}"
		[ -n "$broker_unit" ] && systemctl --user show "$broker_unit" \
			-p ActiveState -p SubState -p Result -p NRestarts -p ExecStart \
			-p NoNewPrivileges -p InaccessiblePaths \
			-p TemporaryFileSystem -p BindPaths -p BindReadOnlyPaths \
			-p CapabilityBoundingSet -p SystemCallFilter \
			-p RestrictAddressFamilies -p MemoryMax -p OOMScoreAdjust -p TasksMax \
			-p LimitNOFILE -p CPUQuotaPerSecUSec -p BindsTo -p After -p Restart -p StartLimitBurst \
			-p PrivateUsersEx -p PrivatePIDs -p ProcSubset -p PrivateIPC
		echo
		echo "=== tether unit: ${tether_unit:-<none>}"
		[ -n "$tether_unit" ] && systemctl --user show "$tether_unit" \
			-p ActiveState -p SubState -p Result -p NRestarts -p ExecStart \
			-p BindsTo -p After -p Restart -p StartLimitBurst \
			-p TemporaryFileSystem -p BindReadOnlyPaths -p PrivateNetwork \
			-p RestrictAddressFamilies -p MemoryDenyWriteExecute -p WorkingDirectory
	} >"$out/artifacts/broker-units.txt" 2>&1
	keep_boot up-broker

	if [ -n "$vm_up" ]; then
		# Every one of these is applied by an *unprivileged* user manager here,
		# and the ones that need privilege fail the unit rather than being
		# ignored. An active broker is the evidence that none of them was
		# refused.
		if grep -q '^ActiveState=active' "$out/artifacts/broker-units.txt"; then
			verdict PASS broker-confined "the confinement set is one an unprivileged user manager accepts"
		else
			verdict FAIL broker-confined "the broker unit is not active — artifacts/broker-units.txt names the property, logs/up-broker/broker.log the rest"
		fi

		# `LoadCredential=` is deliberately not among these. systemd renders it as
		# `[unprintable]` whether a credential was loaded, none was, or the unit
		# never existed — so it can neither confirm nor deny anything, and a check
		# reading it would pass for a broker holding nothing. That the credential
		# arrived is `broker-holds-credential` below, on the broker's own report.
		# The helper is the unit's ExecStart rather than a property, so this is
		# where the broker's own launch shows it ran under it.
		if grep -q "^ExecStart=.*igloo-landlock --connect-tcp 443 --connect-tcp 53 --connect-tcp $model_port -- " "$out/artifacts/broker-units.txt"; then
			verdict PASS broker-under-landlock "the broker's unit runs it under igloo-landlock, allowed TCP to 443, 53 and its model server's port alone"
		else
			verdict FAIL broker-under-landlock "the broker's ExecStart does not go through igloo-landlock — read artifacts/broker-units.txt"
		fi

		# The broker's own, since the tether's unit has an empty root too.
		broker_properties=$(sed -n '/^=== broker unit/,/^=== tether unit/p' "$out/artifacts/broker-units.txt")
		if grep -qx 'TemporaryFileSystem=/:ro' <<<"$broker_properties" &&
			grep -q '^BindReadOnlyPaths=/nix/store:/nix/store:rbind .*-/etc/resolv.conf:' <<<"$broker_properties" &&
			grep -q '^BindPaths=.*-broker:' <<<"$broker_properties"; then
			verdict PASS broker-properties "the confinement took effect, not merely parsed — an empty root, with the store, the resolver's files and its own socket directory bound in"
		else
			verdict FAIL broker-properties "a property did not survive to the running unit — read artifacts/broker-units.txt"
		fi

		# Unbounded unless policy bounds it, and the first process the kernel
		# kills when memory runs out: a score an unprivileged user manager may
		# raise for its own unit, though not lower.
		if grep -qx 'MemoryMax=infinity' "$out/artifacts/broker-units.txt" &&
			grep -qx 'OOMScoreAdjust=1000' "$out/artifacts/broker-units.txt"; then
			verdict PASS broker-oom-first "the broker's unit has no memory bound and the highest OOM score, on a running broker"
		else
			verdict FAIL broker-oom-first "read MemoryMax and OOMScoreAdjust in artifacts/broker-units.txt"
		fi

		# What keeps the broker from the user's other programs is a namespace
		# apiece, so each is read off the running process rather than its unit:
		# its own user, mount, PID and IPC namespaces, as PID 1 of its own, and
		# the host's network, which it needs to reach its upstreams. Then what
		# its root holds: its credential and its socket, and not the home
		# directory, what is in the VM's runtime directory — QEMU's control
		# socket and the copy of the credential staged for the broker — what
		# is in another VM's, whether it was there before the broker started or
		# made after, or the session's sockets, which start units for the
		# asking. Each is there on the host, so its absence is the broker's
		# alone; the session bus is looked for only on a host that has one.
		# Last, every other socket under /run, the system's services among
		# them, counted on the host and in its root, its own aside. A count
		# rather than a list, since the names would say what the host runs.
		broker_id=${broker_unit#igloo-}
		broker_id=${broker_id%-broker.service}
		broker_runtime="$XDG_RUNTIME_DIR/igloo/$broker_id"
		stage_other_vm "$siblings-after"
		hidden=(
			"QEMU's control socket" "$broker_runtime/control.socket"
			'the staged credential' "$broker_runtime/broker-credentials/IGLOO_VERIFY_BROKERED"
			'the TLS key where the project keeps it' "$project/.igloo/tls/key.pem"
		)
		for when in before after; do
			hidden+=(
				"the credential of a VM made $when the broker" "$siblings-$when/broker-credentials/IGLOO_VERIFY_BROKERED"
				"the control socket of a VM made $when the broker" "$siblings-$when/control.socket"
				"the broker socket of a VM made $when the broker" "$siblings-$when-broker/http.sock"
			)
		done
		hidden+=("the user manager's socket" "$XDG_RUNTIME_DIR/systemd/private")
		[ -S "$XDG_RUNTIME_DIR/bus" ] && hidden+=('the session bus' "$XDG_RUNTIME_DIR/bus")
		{
			broker_pid=$(systemctl --user show -P MainPID "$broker_unit")
			confinement "$broker_pid" \
				'its credential' "$(credentials_of "$broker_pid")/IGLOO_VERIFY_BROKERED" \
				'its TLS key' "$(credentials_of "$broker_pid")/broker.tls-key" \
				'its socket' "$broker_runtime-broker/http.sock" \
				'the home directory' "$HOME" \
				"${hidden[@]}"
			for ((at = 1; at < ${#hidden[@]}; at += 2)); do
				[ -e "${hidden[at]}" ] && echo "on the host: ${hidden[at - 1]}"
			done
			echo "sockets under /run on the host: $(find /run -type s 2>/dev/null | wc -l)"
			echo "sockets under /run in its root: $(find "/proc/$broker_pid/root/run" -type s 2>/dev/null | grep -Fvc "$broker_runtime-broker/")"
		} >"$out/artifacts/broker-confinement.txt" 2>&1
		if grep -q '^NSpid:.*[[:space:]]1$' "$out/artifacts/broker-confinement.txt" &&
			[ "$(grep -c '^namespace .* private$' "$out/artifacts/broker-confinement.txt")" = 4 ] &&
			grep -qx 'namespace net shared' "$out/artifacts/broker-confinement.txt"; then
			verdict PASS broker-namespaces "the broker runs as PID 1 in user, mount, PID and IPC namespaces of its own, on the host's network"
		else
			verdict FAIL broker-namespaces "read artifacts/broker-confinement.txt for the broker's PID and namespaces"
		fi
		expected=$(
			printf '%s\n' 'its credential present' 'its TLS key present' 'its socket present' \
				'the home directory absent'
			for ((at = 0; at < ${#hidden[@]}; at += 2)); do echo "${hidden[at]} absent"; done
		)
		if [ "$(grep -E ' (present|absent)$' "$out/artifacts/broker-confinement.txt")" = "$expected" ] &&
			[ "$(grep -c '^on the host: ' "$out/artifacts/broker-confinement.txt")" = $((${#hidden[@]} / 2)) ] &&
			grep -qx 'sockets under /run in its root: 0' "$out/artifacts/broker-confinement.txt" &&
			! grep -qx 'sockets under /run on the host: 0' "$out/artifacts/broker-confinement.txt"; then
			verdict PASS broker-paths "the broker holds its credential, its TLS key and its socket, and finds the home directory, QEMU's control socket, the staged credential, the project's copy of the TLS key, two other VMs' credentials and sockets, the session's sockets and every other socket under /run missing, though all are on the host"
		else
			verdict FAIL broker-paths "read artifacts/broker-confinement.txt for what the broker's root holds"
		fi

		# The tether is an ssh client of a server the guest controls. Read off
		# its running process: PID 1 in user, mount, PID, network and IPC
		# namespaces of its own, under seccomp, with the broker's socket it
		# forwards to and the key it was handed in its root, and not the home
		# directory, the project's own copy of that key, the VM's runtime
		# directory or the brokered credential in it, another VM's runtime and
		# broker directories, or the user manager's socket.
		tether_id=${tether_unit#igloo-}
		tether_id=${tether_id%-tether.service}
		tether_runtime="$XDG_RUNTIME_DIR/igloo/$tether_id"
		forward_confinement "$(systemctl --user show -P MainPID "$tether_unit")" \
			"the broker's socket" "$tether_runtime-broker/http.sock" \
			'the home directory' "$HOME" \
			"the project's key" "$project/.igloo/ssh/id" \
			"the VM's runtime directory" "$tether_runtime" \
			'the brokered credential' "$tether_runtime/broker-credentials/IGLOO_VERIFY_BROKERED" \
			"another VM's runtime directory" "$siblings-before" \
			"another VM's broker directory" "$siblings-before-broker" \
			"the user manager's socket" "$XDG_RUNTIME_DIR/systemd/private" \
			>"$out/artifacts/tether-confinement.txt" 2>&1
		expected=$(printf '%s\n' 'its key present' "the broker's socket present" \
			'the home directory absent' "the project's key absent" \
			"the VM's runtime directory absent" 'the brokered credential absent' \
			"another VM's runtime directory absent" "another VM's broker directory absent" \
			"the user manager's socket absent")
		if grep -q '^NSpid:.*[[:space:]]1$' "$out/artifacts/tether-confinement.txt" &&
			grep -q '^Seccomp:[[:space:]]*2$' "$out/artifacts/tether-confinement.txt" &&
			[ "$(grep -c '^namespace .* private$' "$out/artifacts/tether-confinement.txt")" = 5 ] &&
			[ "$(grep -E ' (present|absent)$' "$out/artifacts/tether-confinement.txt")" = "$expected" ]; then
			verdict PASS tether-confined "the tether runs as PID 1 in user, mount, PID, network and IPC namespaces of its own under seccomp, holding its key and the broker's socket, and finds the home directory, the VM's runtime directory, the brokered credential, another VM's directories and the user manager's socket missing"
		else
			verdict FAIL tether-confined "read artifacts/tether-confinement.txt, and the tether unit in artifacts/broker-units.txt"
		fi

		# The value went in as a path and must appear nowhere else. `systemctl
		# show` is the readback that would expose a SetCredential= value, so it
		# is searched too, along with the broker's own log and the process table.
		{
			echo "=== broker.log"
			cat "$(boot_log broker.log)" 2>&1
			echo
			echo "=== the value anywhere in the unit's properties"
			[ -n "$broker_unit" ] && systemctl --user show "$broker_unit" |
				grep -c 'brokered-value-never-in-the-guest'
			echo "=== the value anywhere in any process argv"
			grep -rl 'brokered-value-never-in-the-guest' /proc/[0-9]*/cmdline 2>/dev/null | wc -l
		} >"$out/artifacts/broker-credential.txt" 2>&1

		if grep -q 'IGLOO_VERIFY_BROKERED' "$out/artifacts/broker-credential.txt" &&
			! grep -q 'brokered-value-never-in-the-guest' "$(boot_log broker.log)"; then
			verdict PASS broker-holds-credential "the broker reports holding it by name and never logs the value"
		else
			verdict FAIL broker-holds-credential "read artifacts/broker-credential.txt — either it did not arrive, or the value was logged"
		fi

		# ------------------------------------------------- what QEMU can open --
		#
		# QEMU's unit sees the store, this VM's runtime directory and two devices.
		# Asked over its own control socket to open files, which it does with its
		# own open(), it has to find each of these missing: one in the home
		# directory, one under /tmp, one in another VM's runtime directory, and
		# the home directory again through the root of a process outside its
		# namespaces. The brokered credential in its own directory is there but
		# refused, and a file of its own opens, which shows the probe can open
		# anything at all. Outcomes only: QEMU's errors repeat the path.
		section "what QEMU can open"
		qemu_unit=$(own_units 'igloo-*-qemu.service' | head -1)
		vm_id=${qemu_unit#igloo-}
		vm_id=${vm_id%-qemu.service}
		runtime="$XDG_RUNTIME_DIR/igloo/$vm_id"
		home_probe=$(mktemp "$HOME/.igloo-verify-probe.XXXXXX")
		other_vm="$XDG_RUNTIME_DIR/igloo/igloo-verify-other-vm"
		mkdir -p "$other_vm"
		for file in "$home_probe" "$scratch/qemu-probe" "$other_vm/probe"; do echo probe >"$file"; done
		cat >"$scratch/qmp-open.ts" <<-'EOF'
			// qmp-open <socket> <path>... — whether KVM is in use, then for each
			// path "opened" or QEMU's reason for not opening it, path removed.
			const [socket = '', ...paths] = process.argv.slice(2)
			const lines: string[] = []
			let buffered = ''
			let wake = () => {}
			const conn = await Bun.connect({
				unix: socket,
				socket: {
					data(_socket, chunk) {
						buffered += chunk.toString()
						for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
							lines.push(buffered.slice(0, at))
							buffered = buffered.slice(at + 1)
						}
						wake()
					},
				},
			})
			const reply = async (): Promise<any> => {
				for (;;) {
					const line = lines.shift()
					if (line === undefined) await new Promise<void>(resolve => (wake = resolve))
					else if (!('event' in JSON.parse(line))) return JSON.parse(line)
				}
			}
			const ask = (command: object) => (conn.write(`${JSON.stringify(command)}\n`), reply())
			await reply()
			await ask({ execute: 'qmp_capabilities' })
			const kvm = await ask({ execute: 'query-kvm' })
			console.log(kvm.return?.enabled === true ? 'kvm enabled' : 'kvm not enabled')
			for (const [index, filename] of paths.entries()) {
				const answer = await ask({
					arguments: { driver: 'file', filename, 'node-name': `igloo-verify-${index}`, 'read-only': true },
					execute: 'blockdev-add',
				})
				console.log('return' in answer ? 'opened' : String(answer.error?.desc).replace(/.*: /, ''))
			}
			conn.end()
		EOF
		{
			bun "$scratch/qmp-open.ts" "$runtime/control.socket" \
				"$runtime/store-paths" \
				"$home_probe" \
				"$scratch/qemu-probe" \
				"$other_vm/probe" \
				"$runtime/broker-credentials/IGLOO_VERIFY_BROKERED" \
				"/proc/$$/root$home_probe" |
				paste - <(printf '%s\n' '' 'its own runtime directory' 'the home directory' \
					'/tmp' "another VM's runtime directory" 'the brokered credential' \
					'the home directory, through /proc/<pid>/root of this script')
			qemu_pid=$(systemctl --user show -P MainPID "$qemu_unit")
			for ns in user mnt pid net ipc; do
				if [ "$(readlink "/proc/$qemu_pid/ns/$ns")" = "$(readlink "/proc/$$/ns/$ns")" ]; then
					echo "namespace $ns shared"
				else
					echo "namespace $ns private"
				fi
			done
		} >"$out/artifacts/qemu-reach.txt" 2>&1
		rm -rf "$home_probe" "$other_vm"

		expected=$(printf '%s\n' opened 'No such file or directory' 'No such file or directory' \
			'No such file or directory' 'Permission denied' 'No such file or directory')
		if [ "$(sed -n '2,7p' "$out/artifacts/qemu-reach.txt" | cut -f1)" = "$expected" ]; then
			verdict PASS qemu-confined "QEMU opens its own files and finds the home directory, /tmp and another VM's directory missing, and the brokered credential refused"
		else
			verdict FAIL qemu-confined "QEMU's view is not the one its unit sets out — read artifacts/qemu-reach.txt"
		fi
		if grep -qx 'kvm enabled' <(cut -f1 "$out/artifacts/qemu-reach.txt") &&
			[ "$(grep -c '^namespace .* private$' "$out/artifacts/qemu-reach.txt")" = 5 ]; then
			verdict PASS qemu-namespaces "confined QEMU still runs the guest under KVM, in user, mount, PID, network and IPC namespaces of its own — and the vsock it was reached over crosses them"
		else
			verdict FAIL qemu-namespaces "read artifacts/qemu-reach.txt for KVM and the namespaces"
		fi

		if [ -n "$cid" ]; then
			{
				echo "=== the guest's end of the tether"
				guest 'ss -ltn "sport = :3128" 2>&1 || cat /proc/net/tcp | head -3'
				echo
				echo "=== a push through it, which the grant must refuse rather than forward"
				guest 'exec 3<>/dev/tcp/127.0.0.1/3128 && printf "GET /github.com/git/git/info/refs?service=git-receive-pack HTTP/1.0\r\n\r\n" >&3 && cat <&3'
				echo
				echo "=== and the brokered value must not be anywhere in the guest"
				guest 'ls /run/credentials/@system/ 2>&1; grep -rl brokered-value-never-in-the-guest /run /etc /root 2>/dev/null | head'
			} >"$out/artifacts/tether.txt" 2>&1

			if grep -q 'may fetch, not push' "$out/artifacts/tether.txt"; then
				verdict PASS tether-reaches-broker "a guest process reaches the broker over the tether, and the grant refuses a push"
			else
				verdict FAIL tether-reaches-broker "the guest did not reach the broker — artifacts/tether.txt says whether the port was even bound"
			fi

			# ------------------------------------------------ the github profile's git --
			#
			# Everything from here reaches a real upstream, which no test does.
			# The token is deliberately invalid: that leaves exactly one link
			# unproven — that a *valid* token authenticates — and proves every
			# other one, including that the broker's own TLS egress works and
			# that a 401 does not reach git.
			section "the github profile's git"
			{
				echo "=== the rewrite the guest was given"
				guest 'git config --list --system 2>&1 | grep -i insteadof'
				echo
				echo "=== a granted repository, over its own https URL"
				guest 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git 2>&1 | head -5'
				echo
				echo "=== the same repository written as an SSH remote"
				guest 'GIT_TERMINAL_PROMPT=0 git ls-remote git@github.com:git/git.git 2>&1 | head -5'
				echo
				echo "=== a repository the grant does not name"
				guest 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/torvalds/linux 2>&1 | head -5'
				echo
				# Copied here because the boot record was kept before any of the
				# above ran.
				echo "=== the tunnel's hand-offs to the broker, from its log"
				grep '"answered":true' "$(boot_log broker.log)"
			} >"$out/artifacts/github-git.txt" 2>&1

			# Read from the guest rather than from the attribute set mkRunner
			# writes: what git reads is the INI `programs.git.config` renders it
			# as.
			if grep -qi 'url.https://github.com/.insteadof=git@github.com:' "$out/artifacts/github-git.txt"; then
				verdict PASS guest-git-rewrite "the guest's system git config sends GitHub's SSH remotes to the https URL the broker answers"
			else
				verdict FAIL guest-git-rewrite "the rewrite is not in the guest's git config — read artifacts/github-git.txt"
			fi

			# The tunnel joined each connection to github.com to the broker's own
			# TLS listener rather than to GitHub.
			if grep -q '"answered":true,"event":"tunnel-open","id":[0-9]*,"target":"github.com:443"' "$out/artifacts/github-git.txt"; then
				verdict PASS github-git-answered "the guest's connections to github.com reached the broker's own TLS listener, not GitHub"
			else
				verdict FAIL github-git-answered "no connection to github.com was answered by the broker — read artifacts/github-git.txt"
			fi

			# What the project keeps for that listener: the authority the guest
			# trusts, the certificate and its key, and not the authority's key.
			{
				echo "=== .igloo/tls"
				ls "$project/.igloo/tls"
				echo "=== modes, of the directory and the key"
				stat -c '%a' "$project/.igloo/tls" "$project/.igloo/tls/key.pem"
			} >"$out/artifacts/broker-tls.txt" 2>&1
			if [ "$(sed -n '2,4p' "$out/artifacts/broker-tls.txt")" = "$(printf '%s\n' authority.pem certificate.pem key.pem)" ] &&
				[ "$(sed -n '6,7p' "$out/artifacts/broker-tls.txt")" = "$(printf '%s\n' 700 600)" ]; then
				verdict PASS broker-tls-kept "the project keeps the authority, the certificate and its key, readable by its owner alone, and no key that signs"
			else
				verdict FAIL broker-tls-kept "read artifacts/broker-tls.txt"
			fi

			# The whole chain in one line: tunnel, the broker's TLS listener and
			# the authority the guest trusts, grant, credential injection, TLS to
			# github.com, and the answer relayed back.
			if grep -q "refused IGLOO_VERIFY_BROKERED" "$out/artifacts/github-git.txt"; then
				verdict PASS github-git-reaches-upstream "a guest clone reaches github.com through the broker, which reports its own credential being refused"
			else
				verdict FAIL github-git-reaches-upstream "the request did not reach the upstream — read artifacts/github-git.txt, then logs/up-broker/broker.log"
			fi

			# git prompts for a username on a 401 whatever the headers say, so an
			# upstream that rejects the broker's token must not be relayed as one.
			if grep -qi 'could not read Username\|Username for' "$out/artifacts/github-git.txt"; then
				verdict FAIL github-git-no-prompt "git asked the guest for a credential, which means a 401 was relayed"
			else
				verdict PASS github-git-no-prompt "a rejected credential is the broker's error, not a prompt inside the guest"
			fi

			if grep -q 'not a repository this VM may fetch' "$out/artifacts/github-git.txt"; then
				verdict PASS github-git-scopes-repos "a repository outside the grant is refused by name"
			else
				verdict FAIL github-git-scopes-repos "an ungranted repository was not refused — read artifacts/github-git.txt"
			fi

			# Pushes, each a dry run: git asks for the push's ref advertisement
			# and sends nothing more. The one to the repository in `write` goes to
			# GitHub with the same invalid token, so it comes back refused; the
			# others never leave the broker.
			{
				echo "=== a push to the repository the grant may push to"
				guest 'cd /tmp && rm -rf pushing && git init -q pushing && cd pushing && git -c user.name=igloo-verify -c user.email=igloo-verify@invalid commit -q --allow-empty -m probe && GIT_TERMINAL_PROMPT=0 git push --dry-run https://github.com/git/git-scm.com HEAD:refs/heads/igloo-verify-probe 2>&1 | head -5'
				echo
				echo "=== a push to one it may only fetch"
				guest 'cd /tmp/pushing && GIT_TERMINAL_PROMPT=0 git push --dry-run https://github.com/git/git HEAD:refs/heads/igloo-verify-probe 2>&1 | head -5'
				echo
				echo "=== a push to one it does not name"
				guest 'cd /tmp/pushing && GIT_TERMINAL_PROMPT=0 git push --dry-run https://github.com/torvalds/linux HEAD:refs/heads/igloo-verify-probe 2>&1 | head -5'
				echo
				echo "=== the pushes the broker allowed, from its log"
				grep '"event":"allow".*"operation":"push' "$(boot_log broker.log)"
			} >"$out/artifacts/github-push.txt" 2>&1
			if grep -q 'refused IGLOO_VERIFY_BROKERED; .* not scoped to git/git-scm.com' "$out/artifacts/github-push.txt" &&
				grep -q '"operation":"push-refs","scope":"git/git-scm.com"' "$out/artifacts/github-push.txt"; then
				verdict PASS github-push-reaches-upstream "a push to a repository in write reaches github.com through the broker, which reports its own credential being refused"
			else
				verdict FAIL github-push-reaches-upstream "read artifacts/github-push.txt, then logs/up-broker/broker.log"
			fi
			if grep -q 'may fetch, not push' "$out/artifacts/github-push.txt" &&
				grep -q 'torvalds/linux is not a repository this VM may push to' "$out/artifacts/github-push.txt"; then
				verdict PASS github-push-refuses "a push to a repository the grant may only fetch, and to one it does not name, is refused at the first request, each with its reason"
			else
				verdict FAIL github-push-refuses "read artifacts/github-push.txt"
			fi

			# GitHub's REST API, answered by the broker as github.com is. The
			# token is the same invalid one, so a granted read reaching GitHub
			# comes back as GitHub refusing the broker's credential.
			{
				echo "=== the token gh is given"
				guest 'printenv GH_TOKEN 2>&1'
				echo
				echo "=== a read under the granted repository"
				guest 'timeout 30 curl -sS https://api.github.com/repos/git/git 2>&1 | head -3'
				echo
				echo "=== a read under a repository the grant does not name"
				guest 'timeout 30 curl -sS https://api.github.com/repos/torvalds/linux 2>&1 | head -3'
				echo
				echo "=== a write under the repository the grant may write"
				guest 'timeout 30 curl -sS -X POST -H "Content-Type: application/json" -d "{\"title\":\"igloo-verify\"}" https://api.github.com/repos/git/git-scm.com/issues 2>&1 | head -3'
				echo
				echo "=== writes to one it may only read, to one it does not name, and of a webhook and a secret to the one it may write"
				guest 'timeout 30 curl -sS -X POST -d "{}" https://api.github.com/repos/git/git/issues 2>&1 | head -3'
				guest 'timeout 30 curl -sS -X POST -d "{}" https://api.github.com/repos/torvalds/linux/issues 2>&1 | head -3'
				guest 'timeout 30 curl -sS -X POST -d "{}" https://api.github.com/repos/git/git-scm.com/hooks 2>&1 | head -3'
				guest 'timeout 30 curl -sS -X PUT -d "{}" https://api.github.com/repos/git/git-scm.com/actions/secrets/X 2>&1 | head -3'
				echo
				echo "=== an asset uploaded to a release of the repository the grant may write"
				guest 'timeout 30 curl -sS -X POST -H "Content-Type: text/plain" --data-binary igloo-verify "https://uploads.github.com/repos/git/git-scm.com/releases/1/assets?name=igloo-verify.txt" 2>&1 | head -3'
				echo
				echo "=== an asset uploaded to a release of one it may only read"
				guest 'timeout 30 curl -sS -X POST -H "Content-Type: text/plain" --data-binary igloo-verify "https://uploads.github.com/repos/git/git/releases/1/assets?name=igloo-verify.txt" 2>&1 | head -3'
				echo
				echo "=== a new gist, and the account's repositories"
				guest 'timeout 30 curl -sS -X POST -d "{}" https://api.github.com/gists 2>&1 | head -3'
				guest 'timeout 30 curl -sS https://api.github.com/user/repos 2>&1 | head -3'
				echo
				echo "=== a GraphQL query"
				guest 'timeout 30 curl -sS -H "Content-Type: application/json" -d "{\"query\":\"query{viewer{login}}\"}" https://api.github.com/graphql 2>&1 | head -3'
				echo
				echo "=== the API's root"
				guest 'timeout 30 curl -sS https://api.github.com/ 2>&1 | head -3'
			} >"$out/artifacts/github-api.txt" 2>&1
			if grep -qx 'igloo-broker-holds-the-real-key' "$out/artifacts/github-api.txt"; then
				verdict PASS github-api-placeholder "the guest's GH_TOKEN is the placeholder, which the broker replaces"
			else
				verdict FAIL github-api-placeholder "read artifacts/github-api.txt"
			fi
			# A read is refused as scoped to its repository, a GraphQL query as
			# scoped to no repository, since nothing in its path names one.
			if grep -q 'api.github.com refused IGLOO_VERIFY_BROKERED; .* not scoped to git/git$' "$out/artifacts/github-api.txt"; then
				verdict PASS github-api-reaches-upstream "a read through the API reaches api.github.com through the broker, which reports its own credential being refused"
			else
				verdict FAIL github-api-reaches-upstream "read artifacts/github-api.txt, then logs/up-broker/broker.log"
			fi
			if grep -q 'api.github.com refused IGLOO_VERIFY_BROKERED; .* not scoped to this request' "$out/artifacts/github-api.txt"; then
				verdict PASS github-graphql-reaches-upstream "a GraphQL query reaches api.github.com through the broker with its credential, bounded by no repository"
			else
				verdict FAIL github-graphql-reaches-upstream "read artifacts/github-api.txt, then logs/up-broker/broker.log"
			fi
			# Sent without the credential, the root would be GitHub's own answer.
			root_said=$(awk '/^=== the API.s root/ { getline; print; exit }' "$out/artifacts/github-api.txt")
			case $root_said in
			*'api.github.com refused IGLOO_VERIFY_BROKERED'*)
				verdict PASS github-api-root "the API's root, where gh auth status reads a token's scopes, is asked with the broker's credential"
				;;
			*)
				verdict FAIL github-api-root "read artifacts/github-api.txt"
				;;
			esac
			if grep -q 'torvalds/linux is not a repository this VM may read' "$out/artifacts/github-api.txt" &&
				grep -q '/gists is not something this VM may write through api.github.com' "$out/artifacts/github-api.txt" &&
				grep -q '/user/repos is not something this VM may read' "$out/artifacts/github-api.txt"; then
				verdict PASS github-api-refuses "another repository, a new gist and the account's repositories are refused through the API, each with its reason"
			else
				verdict FAIL github-api-refuses "read artifacts/github-api.txt"
			fi
			write_said=$(awk '/^=== a write under the repository the grant may write/ { getline; print; exit }' "$out/artifacts/github-api.txt")
			case $write_said in
			*'api.github.com refused IGLOO_VERIFY_BROKERED; '*' not scoped to git/git-scm.com')
				verdict PASS github-api-write-reaches-upstream "a write under a repository in write reaches api.github.com through the broker, which reports its own credential being refused"
				;;
			*)
				verdict FAIL github-api-write-reaches-upstream "read artifacts/github-api.txt, then logs/up-broker/broker.log"
				;;
			esac
			if grep -q 'this VM may read git/git, not write to it' "$out/artifacts/github-api.txt" &&
				grep -q 'torvalds/linux is not a repository this VM may write to' "$out/artifacts/github-api.txt" &&
				grep -q 'POST /repos/git/git-scm.com/hooks is not a write this VM may make' "$out/artifacts/github-api.txt" &&
				grep -q 'PUT /repos/git/git-scm.com/actions/secrets/X is not a write this VM may make' "$out/artifacts/github-api.txt"; then
				verdict PASS github-api-write-refuses "a write through the API to a repository the grant may only read, and to one it does not name, is refused, and so are a webhook and a secret for the one it may write, each with its reason"
			else
				verdict FAIL github-api-write-refuses "read artifacts/github-api.txt"
			fi
			upload_said=$(awk '/^=== an asset uploaded to a release of the repository/ { getline; print; exit }' "$out/artifacts/github-api.txt")
			case $upload_said in
			*'uploads.github.com refused IGLOO_VERIFY_BROKERED; '*' not scoped to git/git-scm.com')
				verdict PASS github-upload-reaches-upstream "an asset uploaded to a release of a repository in write reaches uploads.github.com through the broker, which reports its own credential being refused"
				;;
			*)
				verdict FAIL github-upload-reaches-upstream "read artifacts/github-api.txt, then logs/up-broker/broker.log"
				;;
			esac
			upload_refused=$(awk '/^=== an asset uploaded to a release of one it may only read/ { getline; print; exit }' "$out/artifacts/github-api.txt")
			case $upload_refused in
			*'this VM may read git/git, not write to it'*)
				verdict PASS github-upload-refuses "an asset uploaded to a release of a repository the grant may only read is refused, with its reason"
				;;
			*)
				verdict FAIL github-upload-refuses "read artifacts/github-api.txt"
				;;
			esac

			# The whole point of brokering, stated as the thing that must be absent.
			if grep -q 'brokered-value-never-in-the-guest' "$out/artifacts/tether.txt" ||
				grep -q 'IGLOO_VERIFY_BROKERED' "$out/artifacts/tether.txt"; then
				verdict FAIL broker-value-stays-host "the brokered credential reached the guest, which is the one thing it must not do"
			else
				verdict PASS broker-value-stays-host "the value is nowhere in the guest, by name or by content"
			fi

			# --------------------------------------------- the inference profile --
			#
			# The request is written with a bash redirection rather than a client,
			# so nothing has to be installed in the guest and what is sent is
			# exactly what is written here. The key is the same invalid one, which
			# leaves only "a valid key authenticates" unproven and proves the rest
			# of the chain — base URL, tether, endpoint allowlist, header
			# injection, TLS to the provider.
			section "the inference profile"
			post_to_broker() { # post_to_broker <path> <json body>
				printf 'exec 3<>/dev/tcp/127.0.0.1/3128 && printf %s >&3 && timeout 30 cat <&3\n' \
					"'POST $1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${#2}\r\nConnection: close\r\n\r\n$2'"
			}

			called='{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
			tooled='{"model":"claude-opus-5","max_tokens":16,"messages":[],"tools":[{"type":"web_fetch_20260209","name":"web_fetch"}]}'

			{
				echo "=== the environment the guest was given"
				guest 'printenv ANTHROPIC_BASE_URL ANTHROPIC_API_KEY 2>&1'
				echo
				# One line per client that reads its base URL from its own file:
				# whether it is installed, and if so whether the boot wrote that
				# file pointing at the broker. opencode's is the file its variable
				# names. Each is matched as JSON, quotes and all, since a value that
				# lost its quotes on the way still holds the URL.
				echo "=== the clients pointed at the broker by configuration"
				guest 'for pair in pi:.pi/agent/models.json omp:.omp/agent/models.yml; do
					p=${pair%%:*} f=/root/${pair#*:}
					if ! command -v "$p" >/dev/null; then echo "client-file $p not-installed"
					elif grep -qF "\"baseUrl\": \"http://127.0.0.1:3128/api.anthropic.com\"" "$f" 2>/dev/null; then echo "client-file $p points-at-broker"
					else echo "client-file $p missing"; fi
				done
				grep -qF "\"baseURL\": \"http://127.0.0.1:3128/api.anthropic.com/v1\"" "$OPENCODE_CONFIG" 2>/dev/null &&
					echo "client-env opencode points-at-broker"' 2>&1
				echo
				echo "=== a model call, which should reach the provider and be refused there"
				guest "$(post_to_broker /api.anthropic.com/v1/messages "$called")" 2>&1 | head -20
				echo
				echo "=== a provider-side tool, which is the provider's to run"
				guest "$(post_to_broker /api.anthropic.com/v1/messages "$tooled")" 2>&1 | head -20
				echo
				echo "=== an endpoint the same key would open, outside the grant"
				guest "$(post_to_broker /api.anthropic.com/v1/models "$called")" 2>&1 | head -20
			} >"$out/artifacts/inference.txt" 2>&1

			if grep -q 'ANTHROPIC_BASE_URL' "$out/artifacts/inference.txt" ||
				grep -q '127.0.0.1:3128/api.anthropic.com' "$out/artifacts/inference.txt"; then
				verdict PASS inference-guest-env "the guest's environment points a provider client at the broker"
			else
				verdict FAIL inference-guest-env "the base URL did not reach the guest — read artifacts/inference.txt"
			fi

			# pi and omp read a base URL from their own file alone, which the
			# guest writes at boot where the client is installed; opencode reads
			# its configuration from the file OPENCODE_CONFIG names.
			if grep -q '^client-file .* missing' "$out/artifacts/inference.txt"; then
				verdict FAIL inference-client-config "an installed client's file was not written at boot — read artifacts/inference.txt"
			elif ! grep -q '^client-env opencode points-at-broker' "$out/artifacts/inference.txt"; then
				verdict FAIL inference-client-config "the file OPENCODE_CONFIG names does not point at the broker — read artifacts/inference.txt"
			elif grep -q '^client-file .* not-installed' "$out/artifacts/inference.txt"; then
				verdict NOTE inference-client-config "opencode is pointed at the broker; not installed here, so not checked: $(sed -n 's/^client-file \(.*\) not-installed$/\1/p' "$out/artifacts/inference.txt" | tr '\n' ' ')"
			else
				verdict PASS inference-client-config "pi's, omp's and opencode's configuration point at the broker, written by the guest rather than by hand"
			fi

			# The whole chain, and the one check that proves the broker really
			# talked to the provider rather than answering by itself.
			if sed -n '/^=== a model call/,/^=== a provider-side tool/p' "$out/artifacts/inference.txt" |
				grep -q "refused IGLOO_VERIFY_INFERENCE"; then
				verdict PASS inference-reaches-upstream "a model call reaches api.anthropic.com, which refuses the broker's own credential"
			else
				verdict FAIL inference-reaches-upstream "the request did not reach the provider — read artifacts/inference.txt, then logs/up-broker/broker.log"
			fi

			# The broker reads no body, so a request for a tool the provider runs
			# reaches the provider under `restricted` as under any mode; what the
			# provider does for a model is the provider's.
			if sed -n '/^=== a provider-side tool/,/^=== an endpoint/p' "$out/artifacts/inference.txt" |
				grep -q "refused IGLOO_VERIFY_INFERENCE"; then
				verdict PASS inference-passes-server-tools "under restricted, a request for a provider-side tool reaches the provider, which runs its own tools"
			else
				verdict FAIL inference-passes-server-tools "a request for a provider-side tool did not reach the provider — read artifacts/inference.txt, then logs/up-broker/broker.log"
			fi

			if grep -q 'is not an endpoint this VM may call' "$out/artifacts/inference.txt"; then
				verdict PASS inference-scopes-endpoints "an endpoint outside the grant is refused, so a model key is not a provider key"
			else
				verdict FAIL inference-scopes-endpoints "an ungranted endpoint was not refused — read artifacts/inference.txt"
			fi

			# ------------------------------------------------- a model server --
			#
			# The stand-in on this machine's loopback, reached the way omp would reach
			# it: the guest's own variable, the tether, and the broker under Landlock.
			# That the broker reaches this port and no other beyond 443 and 53 is its
			# ExecStart above, under the helper landlock-keeps shows allows exactly
			# the ports it is given.
			section "a model server"
			get_from_broker() { # get_from_broker <path>
				printf 'exec 3<>/dev/tcp/127.0.0.1/3128 && printf %s >&3 && timeout 30 cat <&3\n' \
					"'GET $1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'"
			}
			{
				echo "=== the variable omp reads"
				guest 'printenv LLAMA_CPP_BASE_URL 2>&1'
				echo
				echo "=== the model listing, through the broker"
				guest "$(get_from_broker /local/igloo-verify/v1/models)" 2>&1 | head -20
				echo
				echo "=== an endpoint of the server's that is not a model call"
				guest "$(get_from_broker /local/igloo-verify/api/captures/1)" 2>&1 | head -20
				echo
				echo "=== what reached the server: method, path, Authorization"
				cat "$scratch/model-server.log" 2>&1
			} >"$out/artifacts/model-server.txt" 2>&1

			if grep -qx 'http://127.0.0.1:3128/local/igloo-verify/v1' "$out/artifacts/model-server.txt"; then
				verdict PASS model-server-guest-env "the guest's LLAMA_CPP_BASE_URL names the model server through the broker"
			else
				verdict FAIL model-server-guest-env "read artifacts/model-server.txt"
			fi

			if grep -q 'igloo-verify-model' "$out/artifacts/model-server.txt" &&
				grep -qx 'GET /v1/models -' "$scratch/model-server.log"; then
				verdict PASS model-server-reached "a guest's model listing reaches a server on this machine's loopback, through the broker under Landlock, with no credential sent"
			else
				verdict FAIL model-server-reached "read artifacts/model-server.txt, then logs/up-broker/broker.log"
			fi

			if grep -q 'is not an endpoint this VM may call' "$out/artifacts/model-server.txt" &&
				! grep -q 'captures' "$scratch/model-server.log"; then
				verdict PASS model-server-endpoints "an endpoint of the server's that is not a model call stops at the broker, and never reaches the server"
			else
				verdict FAIL model-server-endpoints "read artifacts/model-server.txt"
			fi

			# -------------------------------------------- the size of a body --
			#
			# The broker refuses no body for its size: one past Anthropic's own 32
			# MB goes to the provider, whether its length is declared or it arrives
			# in chunks, and the provider's answer comes back. With the invalid key
			# that is the key refused or the provider's own 413, whichever it finds
			# first. The body is written in the guest and sent while the answer is
			# read, since the provider may answer before the body has all arrived.
			section "the size of a body"
			send_sized() { # send_sized <path> <bytes> length|chunked
				guest "bash -s $1 $2 $3" <<'GUEST'
trap '' PIPE
start='{"messages":[],"model":"claude-opus-5","max_tokens":1,"pad":"' end='"}'
pad=$(($2 - ${#start} - ${#end}))
body() { printf %s "$start"; head -c "$pad" /dev/zero | tr '\0' a; printf %s "$end"; }
exec 3<>/dev/tcp/127.0.0.1/3128
if [ "$3" = length ]; then
	{
		printf 'POST %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$1" "$2"
		body
	} >&3 2>/dev/null &
else
	{
		printf 'POST %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n%x\r\n' "$1" "$2"
		body
		printf '\r\n0\r\n\r\n'
	} >&3 2>/dev/null &
fi
timeout 120 cat <&3 | head -c 600
GUEST
			}
			{
				echo "=== past Anthropic's 32 MB, declared"
				send_sized /api.anthropic.com/v1/messages 40000000 length 2>&1
				echo
				echo "=== past Anthropic's 32 MB, in chunks"
				send_sized /api.anthropic.com/v1/messages 40000000 chunked 2>&1
			} >"$out/artifacts/inference-size.txt" 2>&1

			# One line per answer: the broker's refusal of the key, or the status
			# line of the provider's 413.
			if [ "$(grep -cE 'refused IGLOO_VERIFY_INFERENCE|^HTTP/1.1 413' "$out/artifacts/inference-size.txt")" = 2 ]; then
				verdict PASS inference-size-past "a body past Anthropic's 32 MB reaches api.anthropic.com through the broker, declared or chunked, and its answer comes back"
			else
				verdict FAIL inference-size-past "a body past the provider's limit did not reach it, or its answer did not come back — read artifacts/inference-size.txt, then logs/up-broker/broker.log"
			fi

			# ------------------------------------- when the broker is killed --
			#
			# Killed outright, as the kernel kills it when memory runs out. Its
			# unit starts it again where the dead one left its sockets, the guest
			# reaches it again through the tether it never lost, and `ls` says
			# it was restarted.
			section "when the broker is killed"
			if [ -n "$broker_unit" ]; then
				{
					echo "=== before"
					systemctl --user show "$broker_unit" -p MainPID -p NRestarts | sed 's/^MainPID=.*/MainPID=(recorded)/'
					before=$(systemctl --user show -P MainPID "$broker_unit")
					systemctl --user kill --signal=SIGKILL "$broker_unit"
					for _ in $(seq 1 40); do
						sleep 0.5
						now=$(systemctl --user show -P MainPID "$broker_unit")
						[ "$now" != 0 ] && [ "$now" != "$before" ] &&
							[ "$(systemctl --user is-active "$broker_unit")" = active ] && break
					done
					sleep 1
					echo
					echo "=== after"
					systemctl --user show "$broker_unit" -p ActiveState -p NRestarts
					[ "$now" != "$before" ] && echo "a new process"
					echo
					echo "=== a push through the tether, which the new broker must refuse"
					guest 'exec 3<>/dev/tcp/127.0.0.1/3128 && printf "GET /github.com/git/git/info/refs?service=git-receive-pack HTTP/1.0\r\n\r\n" >&3 && timeout 10 cat <&3' 2>&1 | tail -2
					echo
					echo "=== igloo ls"
					own_ls 2>&1
				} >"$out/artifacts/broker-killed.txt" 2>&1
				if grep -qx 'NRestarts=1' "$out/artifacts/broker-killed.txt" &&
					grep -q '^a new process' "$out/artifacts/broker-killed.txt" &&
					grep -q 'may fetch, not push' "$out/artifacts/broker-killed.txt" &&
					grep -q 'up, restarted 1×' "$out/artifacts/broker-killed.txt"; then
					verdict PASS broker-restarts "a broker killed outright is started again, the guest reaches it through the same tether, and ls says it restarted"
				else
					verdict FAIL broker-restarts "read artifacts/broker-killed.txt, then logs/up-broker/broker.log"
				fi
			fi

			# ------------------------------------------- with a real token, opt-in --
			#
			# Last, and on its own VM, because it replaces the credential with
			# one that must not be written down: everything above asserts against
			# a known dummy value, and none of those checks would mean what they
			# say if the value had changed underneath them.
			#
			# The token reaches the scratch config directory and nothing else,
			# and the EXIT trap removes it. It is never echoed into a step file,
			# an artifact or a guest command — which is also why the clone is not
			# checked by grepping the guest for it.
			section "with a real token, opt-in"
			if [ -n "${IGLOO_VERIFY_GITHUB_TOKEN:-}" ]; then
				real_repo=${IGLOO_VERIFY_GITHUB_REPO:-git/git}
				# A repository of the user's own choosing is named nowhere in the record.
				shown_repo=${IGLOO_VERIFY_GITHUB_REPO:+the repository named in IGLOO_VERIFY_GITHUB_REPO}
				shown_repo=${shown_repo:-git/git}
				write_repo=${IGLOO_VERIFY_GITHUB_WRITE_REPO:-}
				write_line=
				[ -z "$write_repo" ] || write_line="write = [ \"$write_repo\" ];"
				printf '%s' "$IGLOO_VERIFY_GITHUB_TOKEN" >"$broker_config/from-file"
				cat >"$broker_config/igloo/igloo-policy.nix" <<EOF
{
  secrets = {
    IGLOO_VERIFY_BROKERED = {
      source = { file = "$broker_config/from-file"; };
      mode = "broker";
      profile = "github";
      repos = [ "$real_repo" ];
      $write_line
      projects = [ "$project" ];
    };
  };
}
EOF
				step down-for-token -- "$repo/bin/igloo" down
				if step up-token -- "$repo/bin/igloo" up; then
					vm_up=yes
					keep_boot up-token
					{
						echo "=== a clone of $shown_repo through the broker"
						guest "GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/$real_repo /tmp/cloned 2>&1 | tail -5"
						echo
						echo "=== the commit it landed on, and where it thinks the remote is"
						guest 'git -C /tmp/cloned rev-parse HEAD 2>&1; git -C /tmp/cloned remote get-url origin 2>&1'
						echo
						echo "=== and the guest still has no credential store of its own"
						guest 'ls /run/credentials/@system/ 2>&1'
						echo
						# Counts and forms only: the repository may be one of the user's.
						echo "=== the repository read through the API: answers naming it"
						guest "timeout 30 curl -sS https://api.github.com/repos/$real_repo 2>&1 | grep -c '\"full_name\"'"
						echo "=== the forms its commits' next page is named in"
						guest "timeout 30 curl -sS -D - -o /dev/null 'https://api.github.com/repos/$real_repo/commits?per_page=1' 2>&1 | grep -i '^link:' | grep -o '/repos/\|/repositories/' | sort -u"
						echo "=== the repository read through GraphQL: answers naming it"
						printf '{"query":"query{repository(owner:\\"%s\\",name:\\"%s\\"){nameWithOwner}}"}' "${real_repo%%/*}" "${real_repo#*/}" |
							guest "timeout 30 curl -sS -H 'Content-Type: application/json' --data-binary @- https://api.github.com/graphql 2>&1 | grep -c '\"nameWithOwner\"'"
						echo
						# Copied for the reason the github-git section gives.
						echo "=== the fetches the broker allowed, from its log"
						grep '"event":"allow".*"operation":"fetch"' "$(boot_log broker.log)"
					} >"$out/artifacts/github-git-clone.txt" 2>&1

					# Through the broker, by its own log: the remote reads as the
					# repository's URL either way.
					if grep -qE '^[0-9a-f]{40}$' "$out/artifacts/github-git-clone.txt" &&
						grep -q '"credential":"IGLOO_VERIFY_BROKERED","event":"allow","host":"github.com","id":[0-9]*,"operation":"fetch"' "$out/artifacts/github-git-clone.txt"; then
						verdict PASS github-git-clone "a real token fetches a real repository, through the broker rather than past it"
					else
						verdict FAIL github-git-clone "the clone did not complete — read artifacts/github-git-clone.txt"
					fi

					# The repository's own answer, once, and its next page named in the
					# form the grant matches rather than by the repository's number.
					api_named=$(awk '/^=== the repository read through the API/ { getline; print; exit }' "$out/artifacts/github-git-clone.txt")
					api_pages=$(awk '/^=== the forms its commits/ { f = 1; next } /^===/ { f = 0 } f && NF' "$out/artifacts/github-git-clone.txt" | tr '\n' ' ')
					if [ "$api_named" = 1 ] && [ "$api_pages" = "/repos/ " ]; then
						verdict PASS github-api-read "a real token reads a real repository through the API, and its next page is named so that it stays within the grant"
					else
						verdict FAIL github-api-read "read artifacts/github-git-clone.txt"
					fi
					# Data back means the broker's token went with it: the guest holds
					# only the placeholder, which GitHub refuses.
					graphql_named=$(awk '/^=== the repository read through GraphQL/ { getline; print; exit }' "$out/artifacts/github-git-clone.txt")
					if [ "$graphql_named" = 1 ]; then
						verdict PASS github-graphql-read "a real token reads a real repository through GraphQL, sent on by the broker"
					else
						verdict FAIL github-graphql-read "read artifacts/github-git-clone.txt"
					fi

					# A new branch pushed, compared, and deleted again. Statuses,
					# counts and GitHub's own reasons only: the repository is the
					# user's. A repository with no commits makes the first branch
					# pushed its default, which GitHub will not delete, so nothing is
					# pushed to one.
					if [ -n "$write_repo" ]; then
						refs_before=$(guest "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/$write_repo >/tmp/scratch-refs 2>/dev/null && wc -l </tmp/scratch-refs || echo unreadable")
						if [ "$refs_before" = 0 ]; then
							verdict NOTE github-push-live "not run: the scratch repository has no commits, so a branch pushed there would become its default, which GitHub will not delete — give it a first commit, such as a README"
							verdict NOTE github-release-live "not run: the scratch repository has no commits, which a release needs"
						elif [ "$refs_before" = unreadable ]; then
							verdict FAIL github-push-live "the scratch repository could not be read through the broker, so nothing was pushed — is IGLOO_VERIFY_GITHUB_WRITE_REPO a repository the token can reach?"
							verdict NOTE github-release-live "not run: the scratch repository could not be read"
						else
							branch=igloo-verify-$(date +%Y%m%d%H%M%S)
							{
								echo "=== the push of a new branch: its status"
								guest "cd /tmp && rm -rf pushed && git init -q pushed && cd pushed && git -c user.name=igloo-verify -c user.email=igloo-verify@invalid commit -q --allow-empty -m 'igloo host-verify' && GIT_TERMINAL_PROMPT=0 git push -q https://github.com/$write_repo HEAD:refs/heads/$branch >/tmp/pushed.out 2>&1; echo \$?"
								echo "=== the branch on GitHub against the commit pushed"
								guest "cd /tmp/pushed && [ \"\$(GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/$write_repo refs/heads/$branch | cut -f1)\" = \"\$(git rev-parse HEAD)\" ] && echo same || echo different"
								echo "=== the push deleting it: its status"
								guest "cd /tmp/pushed && GIT_TERMINAL_PROMPT=0 git push -q https://github.com/$write_repo :refs/heads/$branch >>/tmp/pushed.out 2>&1; echo \$?"
								echo "=== branches of that name left on GitHub"
								guest "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/$write_repo refs/heads/$branch | wc -l"
								echo "=== pushes the broker allowed, from its log"
								grep -c '"event":"allow".*"operation":"push"' "$(boot_log broker.log)"
								echo "=== what GitHub rejected, if anything, the branch's name left out"
								guest "grep -o '\[remote rejected\].*' /tmp/pushed.out | sed 's/igloo-verify-[0-9]*/<branch>/g'"
							} >"$out/artifacts/github-push-live.txt" 2>&1
							said() { awk -v header="=== $1" 'index($0, header) == 1 { getline; print; exit }' "$out/artifacts/github-push-live.txt"; }
							if [ "$(said 'the push of a new branch')" = 0 ] &&
								[ "$(said 'the branch on GitHub')" = same ] &&
								[ "$(said 'the push deleting it')" = 0 ] &&
								[ "$(said 'branches of that name')" = 0 ] &&
								[ "$(said 'pushes the broker allowed')" = 2 ]; then
								verdict PASS github-push-live "a real token pushes a new branch to a repository in write through the broker, and deletes it again"
							else
								verdict FAIL github-push-live "read artifacts/github-push-live.txt; a branch named igloo-verify-… may be left in the scratch repository"
							fi

							# A draft release, given an asset with its length and one in
							# chunks, read back through the API, and deleted. A draft
							# creates no tag, so deleting it leaves nothing behind.
							# Statuses, GitHub's own messages and the host an asset is
							# served from only, for the reason the push gives.
							tag=igloo-verify-$(date +%Y%m%d%H%M%S)
							guest 'head -c 65536 /dev/urandom >/tmp/asset.bin'
							{
								echo "=== the draft release made: its status"
								guest "timeout 30 curl -sS -o /tmp/release.json -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{\"tag_name\":\"$tag\",\"name\":\"igloo host-verify\",\"draft\":true}' https://api.github.com/repos/$write_repo/releases 2>&1 | tail -1"
								release=$(guest "grep -o 'releases/[0-9]*/assets' /tmp/release.json 2>/dev/null | head -1 | tr -dc 0-9")
								if [ -n "$release" ]; then
									echo "=== an asset uploaded with its length: its status"
									guest "timeout 60 curl -sS -o /tmp/upload-sized.json -w '%{http_code}\n' -X POST -H 'Content-Type: application/octet-stream' --data-binary @/tmp/asset.bin 'https://uploads.github.com/repos/$write_repo/releases/$release/assets?name=with-length.bin' 2>&1 | tail -1"
									echo "=== an asset uploaded in chunks: its status, then GitHub's message if it gave one"
									guest "timeout 60 curl -sS -o /tmp/upload-chunked.json -w '%{http_code}\n' -X POST -H 'Content-Type: application/octet-stream' -H 'Transfer-Encoding: chunked' --data-binary @/tmp/asset.bin 'https://uploads.github.com/repos/$write_repo/releases/$release/assets?name=in-chunks.bin' 2>&1 | tail -1; grep -o '\"message\":\"[^\"]*\"' /tmp/upload-chunked.json"
									echo "=== the asset read back through the API: its status, and the host it is sent from"
									guest "timeout 30 curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: application/octet-stream' https://api.github.com/repos/$write_repo/releases/assets/\$(grep -o 'releases/assets/[0-9]*' /tmp/upload-sized.json | head -1 | tr -dc 0-9) 2>&1 | tail -1 | sed -E 's#(https://[^/]*)/.*#\1#'"
									echo "=== the release deleted: its status"
									guest "timeout 30 curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE https://api.github.com/repos/$write_repo/releases/$release 2>&1 | tail -1"
									echo "=== the release read again: its status"
									guest "timeout 30 curl -sS -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/$write_repo/releases/$release 2>&1 | tail -1"
								fi
								echo "=== uploads the broker allowed, from its log"
								grep -c '"event":"allow".*"operation":"upload"' "$(boot_log broker.log)"
								echo "=== writes the broker allowed, from its log"
								grep -c '"event":"allow".*"operation":"write"' "$(boot_log broker.log)"
							} >"$out/artifacts/github-release-live.txt" 2>&1
							released() { awk -v header="=== $1" 'index($0, header) == 1 { getline; print; exit }' "$out/artifacts/github-release-live.txt"; }
							chunked_said=$(awk '/^=== an asset uploaded in chunks/ { getline; s = $0; if ((getline) > 0 && $0 !~ /^===/) s = s " " $0; print s; exit }' "$out/artifacts/github-release-live.txt")
							if [ "$(released 'the draft release made')" = 201 ] &&
								[ "$(released 'an asset uploaded with its length')" = 201 ] &&
								case $(released 'the asset read back') in 302\ https://*) true ;; *) false ;; esac &&
								[ "$(released 'the release deleted')" = 204 ] &&
								[ "$(released 'the release read again')" = 404 ] &&
								[ "$(released 'uploads the broker allowed')" = 2 ] &&
								[ "$(released 'writes the broker allowed')" = 2 ]; then
								verdict PASS github-release-live "a real token makes a draft release in a repository in write through the broker, uploads an asset to it, reads it back, and deletes it — the asset is served from $(released 'the asset read back' | cut -d' ' -f2)"
							else
								verdict FAIL github-release-live "read artifacts/github-release-live.txt; a draft release named igloo host-verify may be left in the scratch repository"
							fi
							verdict NOTE github-upload-chunked "an asset uploaded in chunks, with no length: GitHub answered ${chunked_said:-nothing}"
						fi
					else
						verdict NOTE github-push-live "not run: set IGLOO_VERIFY_GITHUB_WRITE_REPO to a scratch repository the token can push to"
						verdict NOTE github-release-live "not run: IGLOO_VERIFY_GITHUB_WRITE_REPO is not set"
					fi
				else
					verdict FAIL github-git-clone "the VM did not come back up for the token run — read steps/up-token.txt"
				fi
			else
				verdict NOTE github-git-clone "not run: export IGLOO_VERIFY_GITHUB_TOKEN (a fine-grained read-only token) to check that a valid credential actually fetches"
				verdict NOTE github-api-read "not run: IGLOO_VERIFY_GITHUB_TOKEN is not set"
				verdict NOTE github-graphql-read "not run: IGLOO_VERIFY_GITHUB_TOKEN is not set"
				verdict NOTE github-push-live "not run: IGLOO_VERIFY_GITHUB_TOKEN is not set"
				verdict NOTE github-release-live "not run: IGLOO_VERIFY_GITHUB_TOKEN is not set"
			fi

			# ------------------------------------- restricted, and the tunnel --
			#
			# The half that only a host can answer: `restricted` is a claim about
			# a booted guest having no route of its own, and no amount of
			# in-process testing reaches it. Everything here runs against a VM
			# with a NIC it does not have.
			section "restricted, and the tunnel"
			cat >"$broker_config/igloo/igloo-policy.nix" <<EOF
{
  tunnelCeiling = [ "pypi.org" "files.pythonhosted.org" ];
}
EOF
			cat >"$project/igloo-policy.nix" <<'EOF'
{
  network = "restricted";
  tunnel = [ "pypi.org" ];
}
EOF
			# The guest's curl is the content layer the brokered section added.
			# A raw CONNECT, because curl reports the status of a failed tunnel
			# and discards the body — and the body is where the broker says
			# which of refusing, not resolving and not connecting it did.
			connect_via_tunnel() { # connect_via_tunnel <host:port>
				printf 'exec 3<>/dev/tcp/127.0.0.1/3129 && printf %s >&3 && timeout 10 cat <&3\n' \
					"'CONNECT $1 HTTP/1.1\r\nHost: $1\r\n\r\n'"
			}

			step down-for-restricted -- "$repo/bin/igloo" down
			if step up-restricted -- "$repo/bin/igloo" up; then
				vm_up=yes
				{
					echo "=== curl, which only the workspace's module adds"
					guest 'command -v curl || echo "no curl"'
					echo
					echo "=== the guest has no network interface but loopback"
					guest 'ip -o link show 2>&1 || cat /proc/net/dev'
					echo
					echo "=== and no route off the machine"
					guest 'ip route 2>&1; echo "---"; ip -6 route 2>&1'
					echo
					echo "=== the proxy variables it was given"
					guest 'printenv HTTPS_PROXY https_proxy NODE_USE_ENV_PROXY NO_PROXY no_proxy 2>&1'
					echo
					echo "=== both forwarded ports are bound"
					guest 'for p in 3128 3129; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "$p open" || echo "$p closed"; done'
					echo
					echo "=== a direct connection, which must not work without a NIC"
					guest 'timeout 8 bash -c "exec 3<>/dev/tcp/151.101.64.223/443" 2>&1 || echo "direct connection failed, as it must"'
					echo
					echo "=== an allowed destination through the tunnel"
					guest 'timeout 30 curl -sS -x http://127.0.0.1:3129 -o /dev/null -w "pypi %{http_code} in %{time_total}s\n" https://pypi.org/simple/six/ 2>&1'
					echo
					echo "=== and again, which is the only place the learned family shows"
					guest 'timeout 30 curl -sS -x http://127.0.0.1:3129 -o /dev/null -w "pypi again %{http_code} in %{time_total}s\n" https://pypi.org/simple/six/ 2>&1'
					echo
					echo "=== what the tunnel answered for it, in its own words"
					guest "$(connect_via_tunnel pypi.org:443)" 2>&1 | head -5
					echo
					echo "=== a destination the ceiling allows but this project did not list"
					guest "$(connect_via_tunnel files.pythonhosted.org:443)" 2>&1 | head -5
					echo
					echo "=== and one the ceiling never had"
					guest "$(connect_via_tunnel example.com:443)" 2>&1 | head -5
				} >"$out/artifacts/restricted.txt" 2>&1

				# The audit trail for the requests just made. It is this launch's
				# broker rather than the one three launches ago, which is the
				# whole reason each record is kept under the launch's own name.
				keep_boot up-restricted

				if grep -q '^/.*/bin/curl$' "$out/artifacts/restricted.txt"; then
					verdict PASS eval-reads-workspace "a project layer's import from the workspace reached the guest under the confined build"
				else
					verdict FAIL eval-reads-workspace "curl is not in the guest, so the workspace's module was not imported — read artifacts/restricted.txt"
				fi

				# `restricted` is `none` plus a broker, so the NIC's absence is
				# the whole of the guest-side claim.
				if grep -qE '^[0-9]+: (eth0|ens|enp)' "$out/artifacts/restricted.txt"; then
					verdict FAIL restricted-no-nic "the guest has a network interface, so this is not restricted"
				else
					verdict PASS restricted-no-nic "the guest has no interface but loopback, so the broker is the only way out"
				fi

				if grep -q 'direct connection failed' "$out/artifacts/restricted.txt"; then
					verdict PASS restricted-no-direct-egress "a connection straight to an address fails, so nothing routes around the proxy"
				else
					verdict FAIL restricted-no-direct-egress "a direct connection succeeded — read artifacts/restricted.txt"
				fi

				if grep -q '127.0.0.1:3129' "$out/artifacts/restricted.txt" &&
					grep -q '3129 open' "$out/artifacts/restricted.txt"; then
					verdict PASS tunnel-port-bound "HTTPS_PROXY names the tunnel's port, and the second forward is bound"
				else
					verdict FAIL tunnel-port-bound "the tunnel's port or its variable is missing — read artifacts/restricted.txt"
				fi

				# Both spellings, each on a line of its own in printenv's output.
				if [ "$(grep -cx '127.0.0.1,localhost,::1' "$out/artifacts/restricted.txt")" -ge 2 ]; then
					verdict PASS tunnel-bypasses-loopback "NO_PROXY keeps loopback direct, so a server inside the guest is not sent to the proxy"
				else
					verdict FAIL tunnel-bypasses-loopback "NO_PROXY is missing or does not cover loopback — read artifacts/restricted.txt"
				fi

				# The one that proves the whole path: no NIC, and a package index
				# still reachable.
				if grep -q 'pypi 200' "$out/artifacts/restricted.txt"; then
					verdict PASS tunnel-reaches-registry "a VM with no NIC reaches pypi.org through the tunnel"
				else
					verdict FAIL tunnel-reaches-registry "the tunnel did not carry the request — read artifacts/restricted.txt, then logs/up-restricted/broker.log"
				fi

				# A number rather than a threshold: the first connection pays for
				# every address the host cannot reach, and what that costs depends
				# on whether those addresses are refused or dropped. The second
				# fetch is the one that should be quick.
				verdict NOTE tunnel-latency "$(grep -h '^pypi' "$out/artifacts/restricted.txt" | tr '\n' ' ')"

				# The ceiling is what may be asked for; the project's list is what
				# was granted. A host in the first and not the second must fail,
				# and must be named in the refusal rather than merely rejected.
				if grep -q 'files.pythonhosted.org is not a destination this VM may reach' "$out/artifacts/restricted.txt"; then
					verdict PASS tunnel-scopes-destinations "a host the project did not list is refused, even though the ceiling allows it"
				else
					verdict FAIL tunnel-scopes-destinations "an unlisted destination was not refused — read artifacts/restricted.txt"
				fi
			else
				verdict FAIL up-restricted "a restricted VM did not come up — read steps/up-restricted.txt"
			fi

			# --------------------------------------- internet, and the tunnel --
			#
			# The default mode: no NIC either, and the tunnel to any public name.
			# What only a host can answer is the tunnel's address checks against
			# this machine's real addresses — a name nobody listed goes through,
			# and names that resolve inside this machine, or to one of its own
			# public addresses, do not. The content layer above supplies curl.
			# And a bound on the broker's memory, which the user layer alone sets.
			# A github grant, so that github.com is answered by the broker, which
			# sends a read no grant covers on without a credential, since the
			# tunnel reaches github.com itself here.
			section "internet, and the tunnel"
			cat >"$broker_config/igloo/igloo-policy.nix" <<EOF
{
  brokerMem = 64;
  secrets.IGLOO_VERIFY_BROKERED = {
    source = { file = "$broker_config/from-file"; };
    mode = "broker";
    profile = "github";
    repos = [ "git/git" ];
    projects = [ "$project" ];
  };
}
EOF
			printf '{ network = "internet"; }\n' >"$project/igloo-policy.nix"

			# One of this machine's own public addresses, spelled as a wildcard-DNS
			# name that resolves to it — the case only the own-address check can
			# refuse, since the address is as public as anyone's. IPv6, because a
			# machine behind NAT has no public IPv4 of its own.
			own=$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^[23]' | head -1)
			[ -z "$own" ] || own_name="$(printf '%s' "$own" | tr ':' '-').sslip.io"

			step down-for-internet -- "$repo/bin/igloo" down
			if step up-internet -- "$repo/bin/igloo" up; then
				vm_up=yes
				{
					echo "=== the guest has no network interface but loopback"
					guest 'ip -o link show 2>&1 || cat /proc/net/dev'
					echo
					echo "=== a direct connection, which must not work without a NIC"
					guest 'timeout 8 bash -c "exec 3<>/dev/tcp/151.101.64.223/443" 2>&1 || echo "direct connection failed, as it must"'
					echo
					echo "=== a public name no ceiling lists, through the tunnel"
					guest 'timeout 30 curl -sS -o /dev/null -w "example %{http_code}\n" https://example.com/ 2>&1'
					echo
					echo "=== a name that resolves to loopback"
					guest "$(connect_via_tunnel 127-0-0-1.sslip.io:443)" 2>&1 | head -5
					echo
					echo "=== a name that resolves to one of this machine's own public addresses"
					if [ -n "$own_name" ]; then
						guest "$(connect_via_tunnel "$own_name:443")" 2>&1 | head -5
					else
						echo "none: this machine holds no global IPv6 address"
					fi
					echo
					echo "=== the proxy variables it was given"
					guest 'printenv HTTPS_PROXY NO_PROXY 2>&1'
				} >"$out/artifacts/internet.txt" 2>&1
				keep_boot up-internet

				# github.com is answered by the broker here. What no grant covers
				# is sent on bare, and a redirect comes back for the guest to
				# follow through the tunnel.
				{
					echo "=== a public repository the grant does not name"
					guest 'GIT_TERMINAL_PROMPT=0 timeout 60 git ls-remote https://github.com/cli/cli HEAD 2>&1 | head -3'
					echo
					echo "=== a release download from github.com, followed to where it redirects"
					guest 'timeout 60 curl -sSL -o /dev/null -w "release %{http_code} %{num_redirects} %{size_download}\n" https://github.com/cli/cli/releases/download/v2.0.0/gh_2.0.0_checksums.txt 2>&1'
					echo
					# Copied here because the boot record was kept before any of
					# the above ran.
					echo "=== what the broker allowed for github.com, from its log"
					grep '"event":"allow","host":"github.com"' "$(boot_log broker.log)"
				} >"$out/artifacts/github-anonymous.txt" 2>&1
				if grep -qE '^[0-9a-f]{40}[[:space:]]+HEAD$' "$out/artifacts/github-anonymous.txt" &&
					grep -q '"t":"[^"]*","event":"allow","host":"github.com","id":[0-9]*,"operation":"fetch"' "$out/artifacts/github-anonymous.txt"; then
					verdict PASS github-anonymous-fetch "a public repository no grant names is fetched through the broker, with no credential"
				else
					verdict FAIL github-anonymous-fetch "read artifacts/github-anonymous.txt"
				fi
				if grep -qE '^release 200 [1-9][0-9]* [1-9][0-9]*$' "$out/artifacts/github-anonymous.txt" &&
					grep -q '"t":"[^"]*","event":"allow","host":"github.com","id":[0-9]*,"operation":"read"' "$out/artifacts/github-anonymous.txt"; then
					verdict PASS github-anonymous-download "a release download from github.com reaches GitHub with no credential, and its redirect is followed through the tunnel"
				else
					verdict FAIL github-anonymous-download "read artifacts/github-anonymous.txt"
				fi

				if grep -qE '^[0-9]+: (eth0|ens|enp)' "$out/artifacts/internet.txt"; then
					verdict FAIL internet-no-nic "the guest has a network interface, so traffic can leave without the broker"
				else
					verdict PASS internet-no-nic "the guest has no interface but loopback, under the default mode too"
				fi

				if grep -q 'direct connection failed' "$out/artifacts/internet.txt"; then
					verdict PASS internet-no-direct-egress "a connection straight to an address fails, so everything goes through the tunnel"
				else
					verdict FAIL internet-no-direct-egress "a direct connection succeeded — read artifacts/internet.txt"
				fi

				if grep -q 'example 200' "$out/artifacts/internet.txt"; then
					verdict PASS internet-reaches-any-name "a public name nothing listed is reached through the tunnel"
				else
					verdict FAIL internet-reaches-any-name "example.com was not reached — read artifacts/internet.txt, then logs/up-internet/broker.log"
				fi

				if grep -q "127-0-0-1.sslip.io resolves only to addresses inside this machine's own networks" "$out/artifacts/internet.txt"; then
					verdict PASS internet-refuses-inside "a name resolving inside this machine is refused, whatever the name"
				else
					verdict FAIL internet-refuses-inside "a name resolving to loopback was not refused — read artifacts/internet.txt"
				fi

				if [ -z "$own_name" ]; then
					verdict NOTE internet-refuses-own-address "not checked: this machine holds no global IPv6 address to point a name at"
				elif grep -q "resolves only to this machine's own addresses" "$out/artifacts/internet.txt"; then
					verdict PASS internet-refuses-own-address "a name resolving to this machine's own public address is refused"
				else
					verdict FAIL internet-refuses-own-address "a name resolving to this machine's own address was not refused — read artifacts/internet.txt"
				fi

				# A download read more slowly than it arrives: the tunnel holds
				# back the destination rather than buffering it, so the whole of
				# it arrives. Cloudflare's speed test serves as many bytes as asked.
				guest 'timeout 90 curl -sS -o /dev/null --limit-rate 2M -w "slow %{http_code} %{size_download}\n" "https://speed.cloudflare.com/__down?bytes=24000000" 2>&1' \
					>"$out/artifacts/tunnel-slow-reader.txt" 2>&1
				if grep -qx 'slow 200 24000000' "$out/artifacts/tunnel-slow-reader.txt"; then
					verdict PASS tunnel-slow-reader "24 MB read at 2 MB/s through the tunnel arrives whole"
				elif grep -q '^slow 200 ' "$out/artifacts/tunnel-slow-reader.txt"; then
					verdict FAIL tunnel-slow-reader "a slow download was cut short — read artifacts/tunnel-slow-reader.txt, then logs/up-internet/broker.log"
				else
					verdict NOTE tunnel-slow-reader "not checked: speed.cloudflare.com did not answer — read artifacts/tunnel-slow-reader.txt"
				fi

				# `brokerMem` bounds the broker's unit, and a broker past its bound is
				# killed for memory and started again. A bound takes swap away with it,
				# so a host with swap kills it too rather than paging it out. The broker
				# streams what it carries, so no one request takes it past; instead its
				# cgroup is given a bound below what it holds. Its unit starts it again
				# in a fresh cgroup, under `brokerMem`. Last, since it kills the broker.
				internet_broker=$(own_units 'igloo-*-broker.service' | head -1)
				if [ -n "$internet_broker" ]; then
					broker_cgroup=$(systemctl --user show -P ControlGroup "$internet_broker")
					slice_events="/sys/fs/cgroup${broker_cgroup%/*}/memory.events"
					{
						echo "=== the bound"
						systemctl --user show "$internet_broker" -p MemoryMax -p MemorySwapMax
						echo
						echo "=== a bound below what the broker holds"
						restarts=$(systemctl --user show -P NRestarts "$internet_broker")
						echo 4M >"/sys/fs/cgroup$broker_cgroup/memory.max"
						for _ in $(seq 1 40); do
							sleep 0.5
							[ "$(systemctl --user show -P NRestarts "$internet_broker")" != "$restarts" ] &&
								[ "$(systemctl --user is-active "$internet_broker")" = active ] && break
						done
						sleep 1
						echo
						echo "=== after"
						systemctl --user show "$internet_broker" -p ActiveState -p NRestarts -p MemorySwapCurrent
						grep '^oom_kill ' "$slice_events" 2>&1
						echo
						echo "=== igloo ls"
						own_ls 2>&1
					} >"$out/artifacts/broker-memory.txt" 2>&1
					if grep -qx 'MemoryMax=67108864' "$out/artifacts/broker-memory.txt" &&
						grep -qx 'MemorySwapMax=0' "$out/artifacts/broker-memory.txt"; then
						verdict PASS broker-mem-bound "brokerMem in the user layer bounds the broker's unit, swap included, and nothing else does"
					else
						verdict FAIL broker-mem-bound "the broker's unit does not carry brokerMem as MemoryMax with no swap — read artifacts/broker-memory.txt"
					fi
					if grep -q '^oom_kill 0$' "$out/artifacts/broker-memory.txt"; then
						verdict FAIL broker-oom-restarts "not killed: a bound below what the broker held did not get it killed — read artifacts/broker-memory.txt"
					elif grep -qE '^oom_kill [1-9]' "$out/artifacts/broker-memory.txt" &&
						grep -qx 'ActiveState=active' "$out/artifacts/broker-memory.txt" &&
						grep -qE '^NRestarts=[1-9]' "$out/artifacts/broker-memory.txt" &&
						grep -q 'killed for memory' "$out/artifacts/broker-memory.txt"; then
						verdict PASS broker-oom-restarts "a broker killed for memory is started again, and ls says memory was why"
					else
						verdict FAIL broker-oom-restarts "read artifacts/broker-memory.txt, then logs/up-internet/broker.log"
					fi
				fi
			else
				verdict FAIL up-internet "an internet VM did not come up — read steps/up-internet.txt"
			fi
			# Scoped to that check: later blocks declare their own policy, and a
			# content layer left behind would be in their builds too.
			rm -f "$project/igloo.nix" "$project/workspace/igloo-verify-curl.nix"

			# ------------------------------ with a real API key, opt-in, billable --
			#
			# The only check that exercises a *streaming* response, which is the
			# half of the inference profiles nothing else reaches: everything
			# above stops at a 502, and a 502 has no event stream. It costs a
			# handful of tokens.
			#
			# OpenRouter rather than Anthropic: one OpenRouter key takes a model
			# call in each of the three shapes below, while the Anthropic profile
			# needs an API key from the Anthropic Console, which a Claude
			# subscription does not come with — the provider answers 401 to the
			# OAuth token a subscription's client stores.
			#
			# It covers the other profile too: the relay is one code path for
			# every profile — the upstream body is passed through as a stream and
			# `Content-Type` carries with it — so what is left unexercised is the
			# Anthropic *request shape* under streaming, not the streaming.
			section "with a real API key, opt-in, billable"
			if [ -n "${IGLOO_VERIFY_OPENROUTER_KEY:-}" ]; then
				# Overridable because it is the one value here that can go stale
				# without anything in this repository changing: a provider can
				# retire a model id.
				model=${IGLOO_VERIFY_OPENROUTER_MODEL:-openai/gpt-4o-mini}
				printf '%s' "$IGLOO_VERIFY_OPENROUTER_KEY" >"$broker_config/from-file"
				cat >"$broker_config/igloo/igloo-policy.nix" <<EOF
{
  secrets = {
    IGLOO_VERIFY_INFERENCE = {
      source = { file = "$broker_config/from-file"; };
      mode = "broker";
      profile = "openrouter";
      projects = [ "$project" ];
    };
  };
}
EOF
				step down-for-key -- "$repo/bin/igloo" down
				if step up-key -- "$repo/bin/igloo" up; then
					vm_up=yes
					keep_boot up-key
					streamed='{"model":"'"$model"'","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Reply with the single word: brokered"}]}'
					{
						echo "=== a streaming model call with a real key, model $model"
						guest "$(post_to_broker /openrouter.ai/api/v1/chat/completions "$streamed")" 2>&1 | head -40
						echo
						echo "=== and the key is still nowhere in the guest"
						guest 'printenv OPENROUTER_API_KEY; ls /run/credentials/@system/ 2>&1'
					} >"$out/artifacts/inference-stream.txt" 2>&1

					# The events themselves, not just a 200: SSE framing is what a
					# client reads, and a buffered response would still be a 200.
					# Each API carries its tokens in a frame of its own, which is
					# what says they arrived.
					judge_stream() { # judge_stream <slug> <artifact> <token frame> <what it proves>
						if grep -q 'text/event-stream' "$out/artifacts/$2" && grep -q "$3" "$out/artifacts/$2"; then
							verdict PASS "$1" "$4"
						elif grep -q 'refused IGLOO_VERIFY_INFERENCE' "$out/artifacts/$2"; then
							# Distinguished from a broken stream, because the two look
							# identical from here and only one of them is igloo's fault:
							# this branch is the provider's own 401, relayed as the
							# broker's 502 before any stream could start.
							verdict FAIL "$1" "openrouter.ai refused the key itself — check IGLOO_VERIFY_OPENROUTER_KEY, not the broker"
						elif grep -qi 'not a valid model\|"error"' "$out/artifacts/$2"; then
							# The one input here that can go stale on its own.
							verdict FAIL "$1" "the provider rejected the request — if $model has been retired, set IGLOO_VERIFY_OPENROUTER_MODEL"
						else
							verdict FAIL "$1" "no event stream came back — read artifacts/$2"
						fi
					}

					# A chat completions stream has no `event:` lines, so the delta
					# in a `data:` frame is the tokens.
					judge_stream inference-streams inference-stream.txt '^data: .*"delta"' \
						"a real key streams SSE events back through the broker"

					# The other two shapes OpenRouter takes a model call in, for the
					# harnesses that speak them: omp and Codex CLI speak Responses,
					# Claude Code and pi's Claude models Messages.
					responded='{"model":"'"$model"'","max_output_tokens":16,"stream":true,"input":"Reply with the single word: brokered"}'
					guest "$(post_to_broker /openrouter.ai/api/v1/responses "$responded")" \
						>"$out/artifacts/inference-stream-responses.txt" 2>&1
					judge_stream inference-streams-responses inference-stream-responses.txt \
						'response\.output_text\.delta' \
						"a real key streams a Responses API call back through the broker"
					guest "$(post_to_broker /openrouter.ai/api/v1/messages "$streamed")" \
						>"$out/artifacts/inference-stream-messages.txt" 2>&1
					judge_stream inference-streams-messages inference-stream-messages.txt \
						'content_block_delta' \
						"a real key streams a Messages API call back through the broker"

					# The placeholder is what the guest holds; the real key is the
					# host's. Seeing the placeholder is the check passing.
					if grep -q 'igloo-broker-holds-the-real-key' "$out/artifacts/inference-stream.txt"; then
						verdict PASS inference-key-stays-host "the guest holds a placeholder while the real key stays on the host"
					else
						verdict FAIL inference-key-stays-host "the guest's key variable is not the placeholder — read artifacts/inference-stream.txt"
					fi
				else
					verdict FAIL inference-streams "the VM did not come back up for the key run — read steps/up-key.txt"
				fi
			else
				verdict NOTE inference-streams "not run: export IGLOO_VERIFY_OPENROUTER_KEY to check that a valid key streams — it is the only case that exercises SSE, and it bills a few tokens"
			fi
		fi

		# ---------------------------------------------- the broker's teardown --
		#
		# The broker's directory sits beside the VM's runtime directory under
		# XDG_RUNTIME_DIR/igloo, named as the broker unit is without its `igloo-`
		# prefix — so another VM's broker socket is never the one checked.
		section "the broker's teardown"
		broker_sock=""
		if [ -n "$broker_unit" ]; then
			broker_dir=${broker_unit#igloo-}
			broker_sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/igloo/${broker_dir%.service}/http.sock"
		fi
		step down-broker -- "$repo/bin/igloo" down
		vm_up=""

		left=$(own_units 'igloo-*' | grep -c .)
		if [ "$left" = "0" ] && { [ -z "$broker_sock" ] || [ ! -e "$broker_sock" ]; }; then
			verdict PASS broker-teardown "down takes the broker, the tether and the socket with it"
		else
			verdict FAIL broker-teardown "$left units survived, or the socket at ${broker_sock:-<not found>} outlived its VM"
		fi
	fi
	use_layer

	cd "$repo" || exit 1
else
	verdict FAIL init "igloo init produced no project — read steps/init.txt"
fi

# ------------------------------------------------------------------- summary --
section
run_ms=$(ms_between "$run_started" "$EPOCHREALTIME")
run_time=$(printf '%dm%02ds' $((run_ms / 60000)) $((run_ms / 1000 % 60)))

{
	echo "# host-verify $(date -Is)"
	echo
	echo "$pass passed, $fail failed, $warn recorded without a verdict."
	echo
	echo "| verdict | check | what it proves |"
	echo "| --- | --- | --- |"
	while IFS=$'\t' read -r v s w; do
		echo "| $v | \`$s\` | $w |"
	done <"$results"
	echo
	echo "## Where the time went"
	echo
	echo "$run_time in all. Each section in the order it ran, with how much of it its timed"
	echo "commands took; \`artifacts/timings.tsv\` has each of those."
	echo
	echo "| section | seconds | in timed commands |"
	echo "| --- | ---: | ---: |"
	awk -F'\t' '
		FNR == 1 { next }
		FILENAME == ARGV[1] { timed[$1] += $3; next }
		{ printf "| %s | %.1f | %.1f |\n", $1, $2 / 1000, timed[$1] / 1000 }
	' "$timings" "$sections"
	echo
	echo "## Where things are"
	echo
	echo "- \`environment.txt\` — host, nix, and the IGLOO_* variables in play."
	echo "- \`steps/\` — the full output of every command, named by check."
	echo "- \`artifacts/\` — built scripts, unit properties, the guest's answers."
	echo "- \`artifacts/logs/<launch>/\` — one boot record per launch, named by the"
	echo "  check that made it rather than by its boot id: the units' output, the"
	echo "  trail written as the launch happened, and the summary."
	echo "- \`artifacts/boot-phases.tsv\` — every step of every launch, timed."
	echo "- \`artifacts/sections.tsv\` — how long each section of the script took, and"
	echo "  \`artifacts/timings.tsv\` each timed command under its section, in milliseconds."
	echo "- \`REDACTED.txt\` — how many of each \`<label>\` stands in for something that"
	echo "  identified the machine or its user: its addresses, names, paths and the like."
	echo
	echo "## Not covered here"
	echo
	echo "- What a content module cannot set: \`nix flake check\` checks it, with"
	echo "  no host needed."
	echo "- \`igloo attach\` and terminal resize: interactive, so check by hand."
	echo "- The fallback sandbox with a terminal. The checks here drive it from a"
	echo "  pipe, which proves the layout, the cleared environment and the exit"
	echo "  status but not job control or a resize — those need a real tty."
	echo "- A credential source that prompts — gpg-agent, a hardware touch. The"
	echo "  sources here answer immediately, so the 120s budget and the terminal"
	echo "  handoff are unexercised."
	echo "- A launch driven by the packaged CLI. \`packaged-self-sufficient\` runs"
	echo "  its \`doctor\` with the environment stripped, so the prerequisites are"
	echo "  known to resolve from the package alone; every launch below still"
	echo "  goes through the checkout, so the unit environment a packaged launch"
	echo "  hands its daemons is unexercised."
	echo "- A broker under load, or more than one VM brokering at once. Both"
	echo "  launches here are sequential and single-request."
} >"$out/summary.md"

say ""
say "$pass passed, $fail failed, $warn notes, in $run_time."
say "Evidence: $out — start at summary.md."
exit $((fail > 0 ? 1 : 0))
