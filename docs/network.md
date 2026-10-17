# Network

## No network card

No guest has a network card, under any network mode. Its only way out is the _broker_: one process
per VM, running on the host, which the guest reaches through two ports on its own loopback. Those
ports are forwarded over the VM's management channel, so there is no network between the host and
the guest for anything else to use.

| Guest address    | What answers there                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `127.0.0.1:3128` | The broker itself, which makes requests with [credentials](credentials.md) the guest never holds.  |
| `127.0.0.1:3129` | The tunnel: an HTTPS proxy to the destinations policy allows, and to the names the broker answers. |

A VM gets a broker only if it has a brokered credential, a
[model server](credentials.md#model-servers-on-this-machine) or somewhere to tunnel to. One with
none of them has nothing listening on either port, and reaches nothing at all.

When the VM can tunnel, or its broker answers a name, every login session in the guest gets:

```sh
HTTPS_PROXY=http://127.0.0.1:3129
https_proxy=http://127.0.0.1:3129
NODE_USE_ENV_PROXY=1
NO_PROXY=127.0.0.1,localhost,::1
no_proxy=127.0.0.1,localhost,::1
```

Both spellings are set because tools disagree on which they read. `NODE_USE_ENV_PROXY` is needed
because Node's built-in `fetch` ignores the proxy variables without it. `NO_PROXY` keeps loopback
direct, where the broker and any server the guest runs for itself are listening.

The guest resolves no names itself. The tunnel resolves each destination on the host, as the broker
resolves every name it reaches: from the host's `/etc/hosts`, and through the nameservers in its
`/etc/resolv.conf`, which under systemd-resolved is resolved's stub. It does not go through nscd or
any NSS module the host configures. On a host that replaces `/etc/resolv.conf` when its network
changes, rather than rewriting it, a running broker keeps the nameservers it started with until
`igloo down` and `igloo up`.

## Network modes

`network` is one of three values. They differ only in what the broker allows.

| Mode         | The tunnel reaches                             | Brokered credentials and model servers |
| ------------ | ---------------------------------------------- | -------------------------------------- |
| `none`       | nothing                                        | refused                                |
| `restricted` | the hostnames listed in the project's `tunnel` | allowed                                |
| `internet`   | any public hostname                            | allowed                                |

`internet` is the default.

- **`none`** reaches nothing. A project that lists `tunnel` destinations, or has a brokered
  credential or a model server, under `none` is refused, so that nobody believes a VM can reach
  something it cannot. A delivered credential is allowed.
- **`restricted`** reaches the destinations the project lists and whatever its brokered grants
  allow. A brokered credential's upstream does not need to be listed, because the broker reaches it
  itself rather than through the tunnel. `github.com`, for a `github` grant, is reached through the
  tunnel but answered by the broker, so it needs no listing either; listed, it also lets through the
  reads the grant does not cover, with no credential. A model server is reached the same way as an
  upstream, so `restricted` with no `tunnel` and a model server reaches that server and nothing
  else. With no destinations, no brokered credential and no model server, `restricted` reaches
  nothing, and igloo prints a note saying `none` says so more plainly. `restricted` bounds the VM's
  own connections, not what a provider does for a model: a model call may use the provider's own
  tools, such as web search, web fetch or an MCP connector, and through them workspace data can
  reach any address ([what the broker checks](credentials.md#what-the-broker-checks)).
- **`internet`** reaches any public hostname. `tunnel` has no effect under it, and igloo prints a
  note if a project lists destinations anyway.

### How the mode is chosen

1. A project's own `network`, if it sets one. It may not exceed the user layer's `networkCeiling`.
2. Otherwise the user layer's `network`. It may not exceed `networkCeiling` either.
3. Otherwise `networkCeiling`, if it is below `internet`.
4. Otherwise `internet`.

The modes rank `none` < `restricted` < `internet`. A request above the ceiling is an error that
names both files, rather than being lowered quietly.

## The tunnel

The tunnel is an HTTP proxy that accepts `CONNECT` to a hostname on port 443, and nothing else. The
connection inside it is end-to-end TLS between the guest and the destination, so the tunnel cannot
read it, and polices only where it goes.

The exception is a name the broker answers: `github.com`, for a
[`github` grant](credentials.md#how-the-guest-reaches-github). A `CONNECT` to it reaches the broker
rather than the host, under every mode, and the broker is the other end of the TLS, with a
certificate from an authority the guest trusts. A read the grant does not cover is sent on to GitHub
with no credential where the tunnel would have reached `github.com`: under `internet`, or listed
under `restricted`.

- **Port 443 only.** No other port, no plain HTTP, no SSH, no UDP, no DNS and no ICMP, so `ping`,
  `dig` and `git` over SSH do not work. A [`github` grant](credentials.md#github) rewrites GitHub's
  SSH remotes to HTTPS, which the broker answers.
- **Hostnames only.** A `CONNECT` to an IP address is refused.
- **Public addresses only, under every mode.** The tunnel resolves the name on the host and checks
  every address it gets back. It refuses loopback, the private ranges, link-local addresses —
  including the cloud metadata address — carrier-grade NAT, the benchmarking range, multicast and
  reserved addresses, their IPv6 equivalents, and every address of the host's own. So under
  `internet` too, the guest cannot reach the host or its LAN. The connection is made to the address
  that was checked, so a name that changes its answer between two lookups gains nothing.
- **Clients have to use the proxy.** Anything that ignores `HTTPS_PROXY` has no route out. Most
  package managers and HTTP libraries honour it; a tool with its own proxy setting may need it set
  there.

What the address check cannot cover: a listed name that resolves to a publicly routable address that
is private to a VPN the host is connected to. By every test available on the host it is a public
address, so it is reachable.

## Tunnel destinations

Under `restricted`, a project lists its destinations in `tunnel`, and the user layer allows them in
`tunnelCeiling`. A project reaches exactly what it lists. An absent ceiling allows nothing, so the
first destination any project uses has to be allowed in the user layer first:

```nix
{
  programs.igloo.policy = {
    network = "restricted";
    tunnelCeiling = [
      "registry.npmjs.org"
      "pypi.org"
      "files.pythonhosted.org"
    ];
  };
}
```

and then listed in the project's `igloo-policy.nix`:

```nix
{
  tunnel = [
    "pypi.org"
    "files.pythonhosted.org"
  ];
}
```

A destination is a hostname alone: no scheme, no port and no wildcard. It matches exactly, ignoring
case. There is no suffix matching, so `pypi.org` allows neither `www.pypi.org` nor
`files.pythonhosted.org`. A registry's downloads often come from a different host than its index,
and both have to be listed.

## Published ports

`ports` in a project's `igloo-policy.nix` publishes guest ports on the host:

```nix
{
  ports = [
    3000
    {
      guest = 5173;
      host = 5174;
    }
  ];
}
```

A number publishes that guest port on the same host port. `{ guest; host; }` publishes it on a
different host port, for when two projects' servers use the same one. Ports are 1 to 65535. A host
port below 1024 needs privileges a normal user does not have, so publish it on a higher one.

- The host side listens on `127.0.0.1` only, so nothing off the machine reaches a published port.
- The guest side connects to the guest's own `127.0.0.1`. A development server listening on loopback
  inside the guest works as it is; it does not have to listen on `0.0.0.0`.
- Two entries on one host port are refused when the file is read. A host port that something else
  already holds stops the launch with a message naming the port.

Ports are the project's alone. The file that declares them is outside the workspace, so it is
written by the same person the ports are published to.

## Known limits

- The tunnel carries HTTPS on port 443 and nothing else.
- The broker connects to every upstream and tunnel destination directly. It is given no proxy
  setting, and may connect to no port but 443, 53 and a model server's, so on a host that reaches
  the internet only through a proxy, brokered credentials and the tunnel do not work. A model server
  on this machine still does.
- Destinations match exactly, with no wildcards.
- `internet` reaches the whole public internet. Anything the guest can read, it can send there.
- `restricted` stops at the provider. A brokered model call can ask the provider to fetch a URL,
  search the web or connect to an MCP server, and the provider reaches any address it likes, so
  workspace data can leave that way. Turn those tools off in the provider's settings or the agent's
  own if that matters.
- `restricted` stops at a model server too. What the server does for a request is its own, and some
  servers fetch for one, from this machine's network: see
  [what a model server can still reach](credentials.md#what-a-model-server-can-still-reach).
- [`igloo fallback`](troubleshooting.md#igloo-fallback) runs on the host's own network, with none of
  this applied.
