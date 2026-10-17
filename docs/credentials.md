# Credentials

A credential is declared in a policy layer, with a _source_ the host reads its value from and a
_mode_ that decides where the value goes.

## Broker or deliver

|                       | `mode = "broker"`                                                   | `mode = "deliver"`                                      |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Where the value is    | On the host, in the VM's broker process.                            | Inside the guest, at `/run/credentials/@system/<name>`. |
| What the guest gets   | A base URL and a placeholder key, or for git an authority to trust. | The value.                                              |
| What the agent can do | Make the requests its grant allows.                                 | Anything, anywhere the network allows.                  |
| Needs a profile       | Yes.                                                                | No.                                                     |

**Reach for `broker`.** A brokered credential never enters the guest. The broker makes each request
on the guest's behalf, building it from the grant: this provider, these repositories. Nothing the
guest sends reaches the upstream's URL, and the only credential the upstream sees is the broker's.
An agent that is compromised can spend what the grant allows, but it cannot read the key, keep it,
or use it for anything else.

**`deliver` is the escape hatch**, for a credential no broker profile covers. The value is written
to a tmpfs inside the guest, readable by root — the agent. It can copy it into `/workspace` or
`/root`, which persist on the host, and send it to any destination the network mode reaches. The
VM's own copy is gone when it stops, but nothing can say where else it went. Use it only when
nothing else works.

The mode is required, never defaulted, because the two differ in exactly what they expose.

## Declaring a credential

### In a project

A project's `igloo-policy.nix` declares credentials for that project alone:

```nix
{
  network = "restricted";
  secrets.anthropic = {
    source.file = "/run/secrets/anthropic-api-key";
    mode = "broker";
    profile = "anthropic-messages";
  };
}
```

### In the user layer, for several projects

The user layer declares credentials once and lists the projects each one goes to:

```nix
{ config, ... }:
{
  programs.igloo.policy.secrets.github = {
    source.command = [
      "pass"
      "show"
      "github/fine-grained-token"
    ];
    mode = "broker";
    profile = "github";
    repos = [ "alice/demo" ];
    projects = [ "${config.home.homeDirectory}/projects/demo" ];
  };
}
```

`projects` names each project by the absolute path of its root directory, as `igloo init` printed
it. A path that reaches the project through a symlink matches too. Only the user layer can share a
credential between projects: a project's file has no way to name a declaration that does not list
it. If the user layer gives a project a credential with the same name as one the project declares
itself, the launch is refused: a name holds one value.

A credential's name is letters, digits, `_`, `.` and `-`, starting with a letter, digit or
underscore. It is how messages and the broker's log refer to it, and for a delivered credential it
is the file name in the guest. `broker.tls-certificate` and `broker.tls-key` are refused: the broker
holds its own TLS certificate and key under them.

### Fields

| Field      | Applies to         | Value                                                                       |
| ---------- | ------------------ | --------------------------------------------------------------------------- |
| `source`   | every credential   | `{ file = "…"; }` or `{ command = [ … ]; }`                                 |
| `mode`     | every credential   | `"broker"` or `"deliver"`                                                   |
| `profile`  | brokered           | `"anthropic-messages"`, `"openrouter"` or `"github"`                        |
| `repos`    | brokered, `github` | Repositories to fetch and read, as `owner/repo`.                            |
| `write`    | brokered, `github` | Repositories to push to and write through the API as well, as `owner/repo`. |
| `projects` | user layer only    | Absolute paths of the projects' root directories.                           |

A field that does not apply is refused rather than ignored: `repos` or `write` on a model grant, or
`profile` on a delivered credential, would be someone believing they had narrowed something.

A project has at most one brokered credential per profile. A request names no credential, and one to
GitHub's API may name no repository, so the broker would have no way to choose between two.

`models` and `maxOutputTokens` are refused. Which models a key may call and what it may spend are
set on the key, at the provider: OpenRouter has a credit limit and guardrails per key, Anthropic a
spend limit per workspace.

## Sources

The host reads a credential's value every time the VM boots, before the build, so a passphrase
prompt or a hardware-key touch comes while you are still at the terminal. Every credential has to
succeed, or the launch stops. Values are kept on a tmpfs under `XDG_RUNTIME_DIR`, readable only by
you, and removed by `igloo down`. Nothing is written into the project, and no message ever contains
a value.

A changed value reaches a VM the next time it boots: `igloo down`, then `igloo up`.

### `source.file`

```nix
{
  source.file = "/run/secrets/anthropic-api-key";
}
```

The whole file is the value, less one trailing newline if there is one. The path must be absolute,
and is a string. Nothing expands `~`, so in a home-manager configuration write
`"${config.home.homeDirectory}/…"`. Refused:

- **A path in the Nix store.** Everything there is readable by every user on the machine. A path
  written as a Nix path, `./token`, is copied there when the configuration is evaluated, so write it
  as a string.
- **A path inside the project's `workspace/` or `.igloo/home/`**, resolved through symlinks. The
  guest can write both, so it could have pointed the file at anything you can read.

### `source.command`

```nix
{
  source.command = [
    "pass"
    "show"
    "openrouter/api-key"
  ];
}
```

The command is an argument vector, not a shell string. A program named without a `/` is found on
your `PATH`; one named with a `/` must not be inside the project's `workspace/` or `.igloo/home/`.
It runs in the directory of the layer that declared it: the project's root, or the user layer's own
directory in the store.

The value is what the command prints on standard output, less one trailing newline. Exactly one, so
a PEM key's own final newline survives. Its standard input and standard error are your terminal, so
it can prompt. It is refused if it exits non-zero, and what it printed is not used. It is also
refused if it takes longer than 120 seconds, prints nothing, or prints more than 1 MiB.

`pass`, `secret-tool`, `keepassxc-cli`, the 1Password CLI, or a script of your own all fit here.

## Profiles

A brokered credential's `profile` decides its upstream, which is fixed: a grant names what is
reachable there, never where "there" is. The one upstream policy places is a
[model server on this machine](#model-servers-on-this-machine), and only by its port.

### `anthropic-messages`

- **Upstream:** `https://api.anthropic.com`, with an Anthropic API key sent as `x-api-key`.
- **Endpoints:** `POST v1/messages` and `POST v1/messages/count_tokens`.
- **Grant:** the profile alone; the key reaches whichever model a request names.
- **In the guest:**
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:3128/api.anthropic.com`
  - `ANTHROPIC_API_KEY=igloo-broker-holds-the-real-key`

### `openrouter`

- **Upstream:** `https://openrouter.ai`, with an OpenRouter API key sent as a bearer token.
- **Endpoints:** a model call in each of the three shapes agents speak:
  `POST api/v1/chat/completions`, `POST api/v1/responses` (OpenAI's Responses API, which OpenRouter
  keeps no state for) and `POST api/v1/messages` (Anthropic's Messages API). Also the model listings
  `GET api/v1/models`, `api/v1/images/models`, `api/v1/videos/models` and
  `api/v1/embeddings/models`. A listing's query string is carried, so its filters work; no other
  endpoint's is.
- **Grant:** the profile alone; the key reaches whichever model a request names.
- **In the guest:**
  - `OPENROUTER_BASE_URL=http://127.0.0.1:3128/openrouter.ai/api/v1`
  - `OPENROUTER_API_KEY=igloo-broker-holds-the-real-key`

### `github`

- **Upstream:** `https://github.com`, over git's smart HTTP protocol, and GitHub's REST and GraphQL
  APIs at `https://api.github.com`, and its uploads of a release's assets at
  `https://uploads.github.com`, with the token sent the way each takes a fine-grained personal
  access token or a GitHub App installation token.
- **Operations:**
  - Fetching, `git clone`, `git fetch` and `git pull`, from the repositories in `repos` and `write`.
  - Pushing, `git push`, to those in `write`. A push to any other is refused at the first request
    git makes for it, before anything is sent.
  - Reading through the REST API, with `GET` or `HEAD`, anything under `repos/<owner>/<repo>/` for a
    repository in either list, with its query, and the API's root, where GitHub gives a token's
    scopes.
  - Writing through the REST API, under `repos/<owner>/<repo>/` for a repository in `write`, what
    `gh` writes: issues and pull requests, with their comments, labels, reviews and merges, anywhere
    under `issues/` and `pulls/`; releases, anywhere under `releases/`; a run's rerun and cancel and
    a workflow's dispatch, at `actions/runs/<id>/rerun`, `rerun-failed-jobs`, `cancel` and
    `force-cancel`, `actions/jobs/<id>/rerun` and `actions/workflows/<id>/dispatches`; and a
    commit's statuses and checks, at `statuses/<sha>`, `check-runs` and `check-suites`.
  - Uploading a release's asset, `POST repos/<owner>/<repo>/releases/<id>/assets` at
    `uploads.github.com`, for a repository in `write`, with its query, which names the asset.
  - A GraphQL query, `POST graphql`, whatever it reads or writes. The grant does not bound it: see
    [what a grant does not bound](#what-a-grant-does-not-bound).
  - Through the API, everything else is refused: a write to a repository only in `repos`; any other
    write to one in `write`, its settings, collaborators, webhooks, deploy keys, Actions secrets,
    variables and runners, its contents and refs and its labels among them, even where the token
    could make it; another repository; and everything outside `repos/` but the root and `graphql`,
    `gists`, `user/repos` and `search` among it.
- **Grant:** `repos`, the repositories to fetch and read, and `write`, those to push to and write
  through the API as well, which are fetched and read without being listed twice. Either may be left
  out, but not both, and a repository in both is refused. Each is `owner/repo`, with or without
  `.git`, matched ignoring case.
- **In the guest:** `git` is installed, and `GH_TOKEN=igloo-broker-holds-the-real-key`, a
  placeholder for GitHub's CLI, `gh`, which makes no request without a token. The broker answers
  `github.com`, `api.github.com` and `uploads.github.com` itself: a connection to any of them
  through the [tunnel](network.md#the-tunnel) reaches the broker rather than GitHub, under every
  network mode and with no `tunnel` entry. So an ordinary GitHub URL just works, a remote reads as
  the URL it was cloned from, and `gh` finds its repository from it. Its system configuration
  rewrites `git@github.com:` and `ssh://git@github.com/` URLs to `https://github.com/`.

A project has at most one `github` credential: a request to the API may name no repository, so the
broker could not tell which of two pays. List every repository in the one.

A push to a repository in `write` reaches every branch and tag the token can write to. Which ones it
updates is in its body, which the broker does not read, so the bound is the repository's own: its
rulesets, such as no force-push and no deletion on `main`. A token acts as its account, so the token
of an account a ruleset lets bypass it bypasses it from the guest too. To keep an agent off `main`,
use a token of an account that is not on the bypass list. A GitHub App's installation token expires
within an hour, and the broker reads a credential only when the VM boots, so it does not last a
working session.

With `gh` in the guest, `gh auth status` works, and so do its commands that read a listed
repository: `gh run list`, `gh run view`, `gh release list`, `gh release view`, `gh repo view`,
`gh issue list`, `gh pr list`, and `gh api` under `repos/`. Those that read through GraphQL, as most
of `gh pr`, `gh issue` and `gh repo` do, reach whatever the token reaches, listed or not, and those
that write through it, as `gh issue create`, `gh pr comment` and `gh pr merge` do, work if the token
can write. For a repository in `write`, so do those that write through the REST API:
`gh release create`, assets included, `gh release upload`, `gh release edit` and
`gh release delete`, `gh run rerun`, `gh run cancel` and `gh workflow run`. `gh label`,
`gh run delete`, `gh workflow enable` and `disable`, `gh cache delete`, `gh secret` and
`gh variable` write what is refused. GitHub serves a run's logs and a release's assets as redirects
to signed URLs on other hosts, which the broker passes back for the guest to follow through the
tunnel; under `restricted`, list those hosts in `tunnel`. `gh run view --log` and `--log-failed`
read a run's log archive from `results-receiver.actions.githubusercontent.com`, and
`gh release download` reads an asset from `release-assets.githubusercontent.com`.

Scope the token itself to the same repositories. The grant bounds what the broker asks for over git
and the REST API, and the token bounds what GitHub gives; a GraphQL query is bounded by the token
alone. Without `write`, make the token read-only. With it, the token needs Contents write, which a
fine-grained token holds for every repository it reaches, so a GraphQL query can write to one in
`repos` too. A repository that must not be written belongs in neither `write` nor a token that can
write.

### How the guest reaches GitHub

The broker answers `github.com`, `api.github.com` and `uploads.github.com` over TLS with a
certificate of its own, so the guest has to trust what issued it. On the first launch with a
`github` grant, igloo makes a certificate authority for the project with `openssl`, and a
certificate for those names signed by it. It keeps both in `.igloo/tls/`, with the certificate's
key, readable only by you. The guest is built trusting that authority beside the system's own, and
`NODE_EXTRA_CA_CERTS` points Node and Bun at the same list.

- The authority can sign for `github.com` and its subdomains and nothing else: its name constraints
  say so, and its own key is deleted once it has signed the one certificate. What `.igloo/tls/`
  holds can answer GitHub's names to this project's guest, and sign nothing.
- Every request the guest makes to any of them over HTTPS reaches the broker. What the grant covers
  is served with the token. A read no grant covers, a release download, a clone of a public
  repository the grant does not list or an install script's read through the API, is sent to GitHub
  with no credential at all, when the VM's tunnel could reach that name itself: under `internet`, or
  under `restricted` with the name in `tunnel`. A redirect in its answer comes back for the guest to
  follow through the tunnel. Anything else, a write no grant covers among it, is refused with the
  reason.
- GitHub names the next page of a repository's listing by the repository's number, which no grant
  names. On an answer for a listed repository, the broker puts each such link back in the
  `repos/<owner>/<repo>/` form, so a client following it stays within the grant.
- `.igloo/tls/` is made again when it no longer covers the names the broker answers, or is within 30
  days of expiring after ten years. Delete it to have it made again; the next launch rebuilds the
  guest, since the authority is part of it.

Without a repository in `write`, pushing happens from the host, in a repository the agent has
written. Before running `git` there, look at `.git/config` and `.git/hooks`: git runs what they
name, as you.

## Model servers on this machine

A model server running on this machine, such as llama-server, llama-swap, Ollama, LM Studio or vLLM,
can be called from the VM through the broker. It is not a credential, so it is declared in
`modelServers` rather than `secrets`. In a project's `igloo-policy.nix`:

```nix
{
  network = "restricted";
  modelServers.llama-swap.port = 8080;
}
```

Or in the user layer, for the projects it lists:

```nix
{ config, ... }:
{
  programs.igloo.policy.modelServers.llama-swap = {
    port = 8080;
    projects = [ "${config.home.homeDirectory}/projects/demo" ];
  };
}
```

| Field      | Value                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `port`     | The port the server listens on at `127.0.0.1`.                                                                |
| `key`      | Only for a server that requires one: `{ file = "…"; }` or `{ command = [ … ]; }`.                             |
| `projects` | User layer only: the projects' root directories, as for [`secrets`](#in-the-user-layer-for-several-projects). |

The name, `llama-swap` above, is lowercase letters, digits and `-`. It is part of the URL the guest
uses, and names the server in the broker's log. One name declared in both layers is refused. A `key`
is read the way a credential's [source](#sources) is, under the same rules.

- **Upstream:** `http://127.0.0.1:<port>`. The address is always this machine's loopback, so no
  setting can send a request anywhere else, and a `host`, `url` or any other field is refused. The
  server has to listen on `127.0.0.1`: one listening only on `::1` is not reached.
- **Endpoints:** `POST v1/chat/completions`, `POST v1/responses` and `GET v1/models`, which
  OpenAI-compatible servers share, and nothing else. A server's other endpoints are not model calls:
  llama-swap's other endpoints read other clients' recorded requests and its logs, unload models,
  and pass any request through to the server behind it; llama-server's own save its state to files
  and restore it, load and unload models, and change its settings.
- **Key:** with `key`, the broker sends it as a bearer token; without, it sends no credential. The
  guest's own `Authorization` is dropped either way. A server answering `401` comes back as a `403`
  saying it wants a key.
- **Network mode:** refused under `none`. Under `restricted` with no `tunnel`, the server is all the
  VM reaches.
- **Landlock:** the broker may connect to the server's port as well as to 443 and 53. That applies
  to the port on every address; the broker's own code is what keeps it to loopback.
- **In the guest:** the server's base URL is `http://127.0.0.1:3128/local/<name>/v1`.

### What a model server can still reach

The broker passes a model call's body on as the guest wrote it, so what the request asks of the
server is the server's to decide:

- **Models.** A request may name any model the server has, and loading one costs this machine's
  memory. A server that loads models on demand, as llama-swap does, loads whichever is named. Bound
  that in the server's own configuration.
- **Fetches.** Some servers reach the network for a request, from this machine: past the tunnel's
  address checks, LAN included. llama-server downloads an image, audio or video given as an
  `http(s)` URL when it runs with a multimodal projector (`--mmproj`), and llama-swap sends a model
  listed under its `peers` to the remote server named there. Under `restricted`, workspace data can
  leave that way. Run the server without either if that matters.

### Pointing an agent at a model server

- **omp** reads `LLAMA_CPP_BASE_URL`, which the guest sets to the server's base URL when one model
  server is declared, and finds the server's models through `v1/models` itself. With several servers
  the variable is not set, and omp has to be pointed at them in `~/.omp/agent/models.yml`. omp also
  asks a llama.cpp server for `/props` and `/models` to learn its context size; the broker refuses
  both, and omp then assumes 128,000 tokens.
- **pi** takes the server, with its models listed, from `~/.pi/agent/models.json`. Add it beside
  what the file already holds:

  ```json
  {
    "providers": {
      "llama-swap": {
        "baseUrl": "http://127.0.0.1:3128/local/llama-swap/v1",
        "api": "openai-completions",
        "apiKey": "unused",
        "models": [{ "id": "qwen3-8b", "contextWindow": 32768, "maxTokens": 8192 }]
      }
    }
  }
  ```

- **opencode** takes it from `~/.config/opencode/opencode.json`:

  ```json
  {
    "provider": {
      "llama-swap": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://127.0.0.1:3128/local/llama-swap/v1" },
        "models": { "qwen3-8b": {} }
      }
    }
  }
  ```

A key written in either file is not used: the broker drops it.

## What the broker checks

The broker decides from a request's path where it goes and which credential it carries. It does not
read the body, which it streams upstream as it arrives. So **the model** is not checked: any model
passes, or none, with whatever `max_tokens` the request sets. Nor are **the provider's own tools**:
a request may ask for web search, web fetch, code execution or an MCP connector, use OpenRouter's
plugins or a `:online` model, or give an image by URL for the provider to download, under every
[network mode](network.md#network-modes).

What a provider does on a model's behalf is the provider's. Under `restricted` that means workspace
data can leave through a provider-side tool to any address, past the destinations `tunnel` lists.
Turn those tools off in the provider's settings or the agent's own if that matters.

On every brokered request:

- The guest's `Authorization`, `x-api-key`, `Proxy-Authorization` and `Cookie` are dropped, and the
  broker sets its own credential.
- On an inference profile, a model server or GitHub's API, the guest's other headers pass,
  `anthropic-version`, `anthropic-beta`, `x-session-id` and `X-GitHub-Api-Version` included. Those
  about the guest's connection do not: `Host`, `Connection` and the headers it names, the other
  hop-by-hop ones, and `Expect`. Nor do `Accept-Encoding` and `Content-Length`, which the broker
  sets itself: a body goes in chunks, but for a release's asset sent with a `Content-Length` and no
  `Transfer-Encoding`, which goes with that length and is cut off if it runs past it or ends short.
  A request that sends no body, a model listing or a read, carries no `Content-Type` or
  `Content-Encoding` either. On git's requests to `github.com`, the broker builds the headers and
  carries over only git's protocol version and request-body encoding, each checked first. A `github`
  request arrives over TLS and names no host in its path, so the host it was sent to is read
  instead, and only `github.com`, `api.github.com` and `uploads.github.com` are answered.
- The response passes back with its status and body. On an inference profile, a model server or
  GitHub's API its headers pass too, `retry-after`, rate limits and request ids included, except
  `Set-Cookie`, `WWW-Authenticate`, `Proxy-Authenticate`, `Alt-Svc`, `Content-Length`,
  `Content-Encoding` and the hop-by-hop ones. On git's, `Content-Type` is its only header.
- An upstream `401` comes back saying the host's credential was refused: as a `403` on an inference
  profile, a model server or GitHub's API, which a client reports at once rather than retrying, and
  as a `502` on git's requests to `github.com`, so that git does not prompt for credentials the
  guest must not have. A redirect is not followed. One from GitHub's API comes back to the guest,
  which follows it to a signed URL elsewhere without the credential.
- Every refusal the broker writes itself carries `x-should-retry: false`, except the one that may
  pass: an upstream that did not answer.
- No request body is refused for its size. The upstream's own limit is the one a body meets, and on
  an inference profile the upstream's refusal comes back as it gave it. A call is given up on when
  its upstream has not answered within 10 minutes of a model call, a push or an asset's upload, or
  30 seconds of any other request, or when the guest leaves before it answers; a body still being
  sent then is cut off.
- The broker serves as many requests and tunnels at once as the guest opens. Its memory is not
  bounded unless you set `brokerMem`; see [Configuration](configuration.md#policy-settings) and
  [when the broker is killed](troubleshooting.md#when-the-broker-is-killed).

## What a grant does not bound

- **What is sent.** A grant to call a model is a grant to send it anything the guest can read.
- **Models and spend.** A model grant reaches every model the key does, for as many requests as the
  guest makes. Limits on the key itself, at the provider, are the only bound on either.
- **The provider's tools.** A model grant reaches every tool the provider runs for a model, and
  those reach whatever the provider reaches.
- **GitHub's GraphQL API.** A `github` grant sends every GraphQL query with its token, reads and
  writes alike, for whatever repository the query names. A query names repositories in its body,
  which the broker does not read, and much of it by IDs that say which repository they belong to
  only after a lookup, so not even reading it could bound one to the repositories listed. The
  token's own permissions are all that bound it: scope a fine-grained token to exactly the
  repositories listed, with no permission you would not give the agent.
- **Which refs a push updates.** A push to a repository in `write` reaches every branch and tag the
  token can write to. The repository's rulesets bound it, and the grant does not.
- **What a write through the REST API sets.** A write is allowed by its method and its path, and
  what it sets is in its body. A merge lands on whatever branch the pull request targets, and a
  release creates the tag it names, on the commit it names. The repository's rulesets bound those,
  as they bound a push.

## Pointing an agent at the broker

For each inference grant, every login session in the guest gets the base URL and placeholder key
listed under its profile. A model server is covered in
[pointing an agent at a model server](#pointing-an-agent-at-a-model-server). These agents need
nothing more:

- **Claude Code** reads `ANTHROPIC_BASE_URL`.
- **opencode** reads the same base URLs from `/etc/igloo/opencode.json`, which `OPENCODE_CONFIG`
  names and opencode merges over its own configuration.
- **pi** and **omp** take a base URL only from a file in their own directory, so at boot the guest
  writes `~/.pi/agent/models.json` and `~/.omp/agent/models.yml`, naming the broker as each granted
  provider's base. Each is written only if that agent is installed and the file does not exist, so a
  file of your own is never replaced; if you keep one, set its providers' `baseUrl` to the values
  above yourself.

Any other agent needs its base URL set to the same value, which `echo $OPENROUTER_BASE_URL` in the
guest prints, and any non-empty key: the broker replaces it with the real one. That is so whether it
speaks chat completions or the Responses API, as Codex CLI does. Its configuration file lives in
`/root`, so it persists across boots.

An agent that speaks Anthropic's Messages API can use an `openrouter` grant too. Claude Code, for
one, needs `ANTHROPIC_BASE_URL=http://127.0.0.1:3128/openrouter.ai/api`, without the `/v1`, and any
key in `ANTHROPIC_API_KEY`. Set them in `~/.bash_profile`; the guest sets `ANTHROPIC_BASE_URL`
itself only for an `anthropic-messages` grant.

An agent's upstream needs no `tunnel` entry, even under `restricted`. The broker reaches it itself.

Each refusal is recorded in the broker's log, with its reason:

```sh
tail -f .igloo/logs/latest/broker.log
```

The log is in the boot record of the launch that started the broker, which is usually `latest`. It
has one JSON line per event: `listening` as the broker starts, with the credentials it holds by name
and its grants, and `tunnel-listening` with the tunnel's destinations; `allow` with the credential
if there is one, the operation, and the repository for git or the server for a model server; `deny`
with the reason and status, and what the request asked for when the reason names it; `response` with
the status, bytes and time taken; `error` when the upstream could not be reached or refused the
credential; and `tunnel-open`, `tunnel-close` and `tunnel-deny` for each tunnel, with the
destination it asked for. It never contains a credential's value.

## Logins inside the guest

An agent logged in with its own account from inside the guest — a subscription login, an OAuth token
— is outside all of this. Its tokens are in `/root`, which persists on the host in `.igloo/home/`,
and its requests go through the tunnel rather than the broker. Everything in the guest can read
those tokens, which is the same exposure as `deliver`. Under `restricted` it needs its provider's
hosts in `tunnel`; under `none` it cannot reach them at all.

Listing only the provider's hosts narrows where a token can be sent, but does not contain it. Inside
the tunnel the connection is TLS to the provider, so a request using a token read from the guest
reaches the provider unexamined, including one asking for a provider-side tool, such as web fetch or
an MCP connector, that delivers the token somewhere else. A brokered key cannot be sent anywhere
that way, since it never enters the guest.

## Known limits

- There are three profiles, each with a fixed upstream, and model servers on this machine. Other
  providers, and a model server on another machine, cannot be brokered.
- Each profile serves only the endpoints listed. Anthropic's model listing, and file and batch
  endpoints, are not served.
- `restricted` stops at the provider. A model call can have the provider fetch a URL, search the web
  or connect to an MCP server, and the provider reaches any address it likes, so workspace data can
  leave that way.
- opencode, omp and pi have completed sessions through `openrouter`, omp on the Responses API. pi's
  Claude models on OpenRouter fail as the guest configures them: pi gives every model of a provider
  the one base URL, and sends a Claude model to `<base>/v1/messages`, which makes
  `api/v1/v1/messages`. A `models` entry for that model in `~/.pi/agent/models.json` with
  `"baseUrl": "http://127.0.0.1:3128/openrouter.ai/api"` reaches the Messages endpoint. The entry
  replaces pi's own description of the model, so give it `reasoning`, `input`, `contextWindow` and
  `maxTokens` as well.
- Claude Code through `anthropic-messages` is untested against Anthropic itself. The broker passes
  its requests on as described above, but none has yet been sent to Anthropic with a real key, so it
  may not work.
- The broker verifies an upstream's certificate against the root certificates bundled with Bun,
  which it runs on, and no others. A certificate authority the host trusts, through
  `security.pki.certificates` or otherwise, does not reach it, so behind a proxy that intercepts TLS
  every request to a profile's upstream fails verification. The tunnel does not open the TLS it
  carries, so there the guest's own client does the verifying, and a content module can give the
  guest the authority with `security.pki.certificates`.
- `github` pushes and writes through the REST API only for the repositories in `write`, and through
  the REST API writes only what its operations list. Its GraphQL API is passed with the token, and
  the grant does not bound what a query reads or writes.
- With a `github` grant, nothing in the guest reaches `github.com`, `api.github.com` or
  `uploads.github.com` but through the broker. Under `restricted` without them in `tunnel`, that
  means only the repositories listed: a release download from `github.com`, a clone of any other
  repository, or an anonymous read through the API, is refused.
- Under `restricted`, one job's log, read through the API at `actions/jobs/<id>/logs`, is out of
  reach. GitHub redirects it to one of a set of numbered storage hosts,
  `productionresultssa<n>.blob.core.windows.net`, which differs from job to job, and `tunnel` names
  hosts exactly. A whole run's log archive comes from one host that can be listed.
- A path holding a percent-escape is refused, so an API read naming a branch with a `/` in it, as
  `branches/feature%2Fx`, is refused.
- A client that verifies against a list of certificate authorities of its own, rather than the
  system's, does not trust the broker's, and fails to reach `github.com` from the guest. Node and
  Bun read `NODE_EXTRA_CA_CERTS`, which the guest sets; point any other at
  `/etc/ssl/certs/ca-certificates.crt`.
- A credential's value is read only when the VM boots.
