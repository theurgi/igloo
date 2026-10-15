#!/usr/bin/env bash
#
# Scrub a directory of host-run evidence in place, replacing whatever
# identifies the machine or the person running it with a label:
#
#     scripts/redact.sh <dir> [< values]
#
# The host scripts run it over their own output on the way out, and it can be
# run by hand over any older output directory. It is the backstop, not the
# policy: a check should not record identifying data to begin with. What this
# catches is text no check chooses the words of — nix's errors, a guest's
# console, a daemon's log.
#
# Replaced, each by a label in angle brackets:
#
#   - the home directory, the user name and the host name
#   - every address of this machine, and any address inside its networks
#   - its gateways, its DNS servers other than well-known public ones, and its
#     DNS search domains
#   - hardware addresses, network interface names and network connection names
#   - each value given on stdin, one <label>=<value> per line — stdin rather
#     than arguments, so that a credential never appears in a process listing.
#     Prefixed with word: or addr:, a value is replaced only as a whole name or
#     a whole address; bare, it is replaced wherever it occurs.
#
# The values are read from this machine as it runs, so run it on the machine
# the evidence came from. They are held in a private temporary file and removed
# on exit. It reports how many of each label it wrote, never what it replaced,
# and leaves the same count in REDACTED.txt in the directory.

set -u
dir=${1:?usage: redact.sh <dir> [< <label>=<value> lines]}
[ -d "$dir" ] || {
	echo "not a directory: $dir" >&2
	exit 2
}

work=$(mktemp -d -t igloo-redact.XXXXXXXX)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
rules="$work/rules"
: >"$rules"

# Values short enough, or common enough, to occur in ordinary output. Replacing
# one of these would corrupt the evidence — a user called `dev` would turn every
# `/dev` into a label — while identifying nobody.
ordinary=" root user users admin dev test guest home nixos localhost system server desktop laptop workstation nix igloo host main default local "

emit() { # emit <kind> <label> <value>
	local value=$3
	[ -n "$value" ] || return 0
	case $1 in
	word)
		[ ${#value} -ge 3 ] || return 0
		[[ $ordinary == *" ${value,,} "* ]] && return 0
		;;
	esac
	printf '%s\t%s\t%s\n' "$1" "$2" "$value" >>"$rules"
}

# Public resolvers anyone might configure. Replacing them would say nothing
# about this machine and would make DNS evidence unreadable.
well_known_dns=" 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 9.9.9.9 149.112.112.112 208.67.222.222 208.67.220.220 2606:4700:4700::1111 2606:4700:4700::1001 2001:4860:4860::8888 2001:4860:4860::8844 2620:fe::fe 2620:fe::9 "

# A bare value is replaced wherever it occurs, which is right for a credential.
# A name or an address is replaced only whole, so that a machine called `z`
# does not take every z with it.
if [ ! -t 0 ]; then
	while IFS= read -r pair; do
		kind=raw
		case $pair in
		word:*)
			kind=word
			pair=${pair#word:}
			;;
		addr:*)
			pair=${pair#addr:}
			case ${pair#*=} in *:*) kind=addr6 ;; *) kind=addr4 ;; esac
			;;
		esac
		case $pair in
		"") ;;
		*=*) emit "$kind" "<${pair%%=*}>" "${pair#*=}" ;;
		*) echo "ignoring a line of stdin: expected [word:|addr:]<label>=<value>" >&2 ;;
		esac
	done
fi

# A home of / or /root is also a path the guest has, and would be replaced there.
case ${HOME:-/} in
/ | /root) ;;
*)
	emit path "~" "$HOME"
	real_home=$(realpath "$HOME" 2>/dev/null)
	[ "$real_home" = "$HOME" ] || emit path "~" "$real_home"
	;;
esac
emit word "<user>" "$(id -un 2>/dev/null)"
for name in "$(uname -n)" "$(cat /etc/hostname 2>/dev/null)" "$(hostname -f 2>/dev/null)"; do
	emit word "<hostname>" "$name"
done

while read -r family address; do
	case $family in
	inet) emit addr4 "<host-ipv4>" "${address%/*}" ;;
	inet6) emit addr6 "<host-ipv6>" "${address%/*}" ;;
	esac
done < <(ip -o addr show 2>/dev/null | awk '$2 != "lo" { print $3, $4 }')

ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") print $(i + 1) }' |
	while read -r gateway; do emit addr4 "<gateway>" "$gateway"; done
ip -6 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") print $(i + 1) }' |
	while read -r gateway; do emit addr6 "<gateway>" "$gateway"; done

# Networks narrower than these are the machine's own; a route wider than them —
# a VPN's 0.0.0.0/1, say — would turn every address on the internet into a label.
ip -4 route show 2>/dev/null | awk '$1 ~ /\// && $1 !~ /^127\./ { split($1, a, "/"); if (a[2] >= 8) print $1 }' |
	while read -r net; do emit net4 "<lan-ipv4>" "$net"; done
ip -6 route show 2>/dev/null | awk '$1 ~ /\// && $1 !~ /^(fe80|ff|::)/ { split($1, a, "/"); if (a[2] >= 32) print a[1] }' |
	while read -r prefix; do
		case $prefix in
		*::*) emit pre6 "<lan-ipv6>" "${prefix%%::*}:" ;;
		*) emit pre6 "<lan-ipv6>" "$(cut -d: -f1-4 <<<"$prefix"):" ;;
		esac
	done

{
	awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf 2>/dev/null
	resolvectl dns 2>/dev/null | sed 's/^[^:]*://' | tr ' ' '\n' | sed 's/#.*//'
} | grep -E '^[0-9a-fA-F.:]+$' | sort -u | while read -r server; do
	case $server in 127.* | ::1) continue ;; esac
	[[ $well_known_dns == *" $server "* ]] && continue
	case $server in
	*:*) emit addr6 "<dns>" "$server" ;;
	*) emit addr4 "<dns>" "$server" ;;
	esac
done
{
	awk '$1 == "search" || $1 == "domain" { for (i = 2; i <= NF; i++) print $i }' /etc/resolv.conf 2>/dev/null
	resolvectl domain 2>/dev/null | sed 's/^[^:]*://' | tr ' ' '\n'
} | grep -v '^~\?\.\?$' | sed 's/^~//' | sort -u | while read -r domain; do
	emit word "<search-domain>" "$domain"
done

for iface in /sys/class/net/*; do
	name=${iface##*/}
	[ "$name" = lo ] && continue
	emit word "<iface>" "$name"
	mac=$(cat "$iface/address" 2>/dev/null)
	[ "$mac" = 00:00:00:00:00:00 ] || emit raw "<mac>" "$mac"
done
if command -v nmcli >/dev/null; then
	nmcli -t -f NAME connection show --active 2>/dev/null | sed 's/\\:/:/g' |
		while read -r name; do emit word "<network>" "$name"; done
	nmcli -t -f active,ssid device wifi 2>/dev/null | awk -F: '$1 == "yes" { print $2 }' |
		while read -r name; do emit word "<network>" "$name"; done
fi

# Most specific first: a value given by the caller, then paths, then single
# addresses, then whole networks, then names. Longer values before shorter ones
# of the same kind, so one never replaces part of another.
sort_rules() {
	awk "!seen[\$0]++" "$rules" | awk -F'\t' '{
		p = ($1 == "raw") ? 1 : ($1 == "path") ? 2 : ($1 ~ /^addr/) ? 3 : ($1 ~ /^(net4|pre6)$/) ? 4 : 5
		print p "\t" length($3) "\t" $0
	}' | sort -t$'\t' -k1,1n -k2,2nr | cut -f3-
}
sort_rules >"$work/sorted"

cat >"$work/redact.awk" <<'AWK'
BEGIN { FS = "\t" }
FNR == NR { kind[++n] = $1; label[n] = $2; value[n] = $3; next }
{
	line = $0
	for (i = 1; i <= n; i++) {
		if (kind[i] == "net4") line = net4(line, value[i], label[i])
		else if (kind[i] == "pre6") line = pre6(line, value[i], label[i])
		else line = literal(line, kind[i], value[i], label[i])
	}
	print macs(line)
}
END { for (l in count) printf "%s\t%d\n", l, count[l] >> counts }

function ok_before(k, c) {
	if (c == "" || k == "raw" || k == "path") return 1
	if (k == "addr4") return c !~ /[0-9.]/
	if (k == "addr6") return c !~ /[0-9A-Fa-f:]/
	return c !~ /[A-Za-z0-9_]/
}
function ok_after(k, c, c2) {
	if (c == "" || k == "raw") return 1
	if (k == "path") return c !~ /[A-Za-z0-9_.-]/
	if (k == "addr4") return c !~ /[0-9]/ && !(c == "." && c2 ~ /[0-9]/)
	if (k == "addr6") return c !~ /[0-9A-Fa-f:]/
	return c !~ /[A-Za-z0-9_]/
}

# Every bounded occurrence of v in s, replaced by lab.
function literal(s, k, v, lab,    out, p, L, last, before) {
	out = ""; last = ""; L = length(v)
	while ((p = index(s, v)) > 0) {
		before = (p > 1) ? substr(s, p - 1, 1) : last
		if (ok_before(k, before) && ok_after(k, substr(s, p + L, 1), substr(s, p + L + 1, 1))) {
			out = out substr(s, 1, p - 1) lab
			last = substr(v, L, 1)
			s = substr(s, p + L)
			count[lab]++
		} else {
			out = out substr(s, 1, p)
			last = substr(s, p, 1)
			s = substr(s, p + 1)
		}
	}
	return out s
}

# Every IPv6 address beginning with the prefix, replaced whole.
function pre6(s, v, lab,    out, p, j, last, before) {
	out = ""; last = ""
	while ((p = index(s, v)) > 0) {
		before = (p > 1) ? substr(s, p - 1, 1) : last
		if (ok_before("addr6", before)) {
			j = p + length(v)
			while (substr(s, j, 1) ~ /[0-9A-Fa-f:]/ && j <= length(s)) j++
			out = out substr(s, 1, p - 1) lab
			last = substr(s, j - 1, 1)
			s = substr(s, j)
			count[lab]++
		} else {
			out = out substr(s, 1, p)
			last = substr(s, p, 1)
			s = substr(s, p + 1)
		}
	}
	return out s
}

function ip4num(a,    o) {
	if (split(a, o, ".") != 4) return -1
	if (o[1] > 255 || o[2] > 255 || o[3] > 255 || o[4] > 255) return -1
	return ((o[1] * 256 + o[2]) * 256 + o[3]) * 256 + o[4]
}

# Every IPv4 address inside the network, replaced.
function net4(s, cidr, lab,    parts, base, size, out, rest, a, n, before, after, after2) {
	split(cidr, parts, "/")
	size = 2 ^ (32 - parts[2])
	base = int(ip4num(parts[1]) / size) * size
	out = ""; rest = s
	while (match(rest, /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) {
		a = substr(rest, RSTART, RLENGTH)
		before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : substr(out, length(out), 1)
		after = substr(rest, RSTART + RLENGTH, 1)
		after2 = substr(rest, RSTART + RLENGTH + 1, 1)
		n = ip4num(a)
		if (n >= base && n < base + size && ok_before("addr4", before) && ok_after("addr4", after, after2)) {
			out = out substr(rest, 1, RSTART - 1) lab
			count[lab]++
		} else {
			out = out substr(rest, 1, RSTART + RLENGTH - 1)
		}
		rest = substr(rest, RSTART + RLENGTH)
	}
	return out rest
}

# Any hardware address not already replaced by name, but igloo's own guest NIC,
# which is the same constant on every machine.
function macs(s,    out, rest, m, before, after, h) {
	h = "[0-9A-Fa-f][0-9A-Fa-f]"
	out = ""; rest = s
	while (match(rest, h ":" h ":" h ":" h ":" h ":" h)) {
		m = substr(rest, RSTART, RLENGTH)
		before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : substr(out, length(out), 1)
		after = substr(rest, RSTART + RLENGTH, 1)
		if (tolower(m) != "02:00:00:00:00:01" && before !~ /[0-9A-Fa-f:]/ && after !~ /[0-9A-Fa-f:]/) {
			out = out substr(rest, 1, RSTART - 1) "<mac>"
			count["<mac>"]++
		} else {
			out = out substr(rest, 1, RSTART + RLENGTH - 1)
		}
		rest = substr(rest, RSTART + RLENGTH)
	}
	return out rest
}
AWK

counts="$work/counts"
: >"$counts"
# A file this could not rewrite still holds what it was meant to lose, so each
# one is named on the way out rather than passed over.
unscrubbed=()
while IFS= read -r -d '' file; do
	# Only the kinds of file the host scripts write, and only if there is no NUL
	# in them: a binary rewritten line by line is a corrupted binary.
	case ${file##*/} in
	*.txt | *.md | *.tsv | *.log | *.json | *.jsonl | *.nix | *.sh | *.diff) ;;
	*) continue ;;
	esac
	[ "$(tr -d '\0' <"$file" | wc -c)" = "$(wc -c <"$file")" ] || continue
	# Counted per file and kept only once the file is rewritten, so the tally
	# says what was replaced rather than what would have been.
	: >"$work/file-counts"
	if ! LC_ALL=C awk -v counts="$work/file-counts" -f "$work/redact.awk" "$work/sorted" "$file" >"$work/out"; then
		unscrubbed+=("${file#"$dir"/}")
		continue
	fi
	# A copy out of the Nix store keeps the store's read-only mode.
	[ -w "$file" ] || chmod u+w "$file" 2>/dev/null
	if { cat "$work/out" >"$file"; } 2>/dev/null; then
		cat "$work/file-counts" >>"$counts"
	else
		unscrubbed+=("${file#"$dir"/}")
	fi
done < <(find "$dir" -type f ! -name REDACTED.txt -print0)

summary=$(awk -F'\t' '{ n[$1] += $2 } END { for (l in n) printf "  %-18s %d\n", l, n[l] }' "$counts" | sort)
{
	echo "Scrubbed by scripts/redact.sh on $(date '+%Y-%m-%d %H:%M'). Labels in angle brackets"
	echo "replace values read from the machine the run happened on."
	echo
	echo "${summary:-  nothing needed replacing}"
	if [ ${#unscrubbed[@]} -gt 0 ]; then
		echo
		echo "NOT scrubbed — these could not be rewritten, so read them before sharing:"
		printf '  %s\n' "${unscrubbed[@]}"
	fi
} >"$dir/REDACTED.txt"
echo "redacted $dir:" >&2
echo "${summary:-  nothing needed replacing}" >&2
if [ ${#unscrubbed[@]} -gt 0 ]; then
	echo "NOT scrubbed, so read them before sharing:" >&2
	printf '  %s\n' "${unscrubbed[@]}" >&2
	exit 1
fi
