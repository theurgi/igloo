# Credentials

A credential is declared in a policy layer, with a _source_ the host reads its value from and a
_mode_ that decides where the value goes.

## Broker or deliver

|                       | `mode = "broker"`                                                              | `mode = "deliver"`                                      |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Where the value is    | On the host, in the VM's broker process.                                       | Inside the guest, at `/run/credentials/@system/<name>`. |
| What the guest gets   | A placeholder key, and an authority to trust for the names the broker answers. | The value.                                              |
| What the agent can do | Make the requests its grant allows.                                            | Anything, anywhere the network allows.                  |
| Needs a profile       | Yes.                                                                           | No.                                                     |

**Reach for `broker`.** A brokered credential never enters the guest. The broker makes each request
on the guest's behalf, building it from the grant: this provider, these repositories. Nothing the
guest sends reaches the upstream's URL but what the grant's rules allow, and the only credential the
upstream sees is the broker's. An agent that is compromised can spend what the grant allows, but it
cannot read the key, keep it, or use it for anything else.

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
    hosts = [ "api.anthropic.com" ];
    allow = [ "messages" ];
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
    hosts = [
      "api.github.com"
      "github.com"
    ];
    allow = [ "graphql" ];
    repos."alice/demo" = [
      "fetch"
      "read"
    ];
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

| Field      | Applies to                            | Value                                                                           |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `source`   | every credential                      | `{ file = "…"; }` or `{ command = [ … ]; }`                                     |
| `mode`     | every credential                      | `"broker"` or `"deliver"`                                                       |
| `profile`  | brokered                              | A [profile](#profiles): one of igloo's, or one a layer defines.                 |
| `hosts`    | brokered                              | Exactly the hosts the sets chosen reach.                                        |
| `allow`    | brokered                              | The profile's sets this credential allows for the whole account.                |
| `repos`    | brokered, a profile with repositories | Each repository, as `"owner/repo"`, with the sets this credential allows there. |
| `projects` | user layer only                       | Absolute paths of the projects' root directories.                               |

A field that does not apply is refused rather than ignored: `repos` on a profile without
repositories, or `profile` on a delivered credential, would be someone believing they had narrowed
something. A grant chooses at least one set, in `allow` or under a repository. A grant of a profile
with none of `hosts`, `allow` and `repos`, as one was written before profiles had sets, is refused
with the lines that keep what it allowed: every set.

A project has at most one brokered credential per profile, and no two of its grants may reach one
host. A request names no credential, and one to GitHub's API may name no repository, so the broker
would have no way to choose between two.

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

A brokered credential's `profile` says what its key may do at a service: the hosts it is sent to,
how it is sent at each, and named **sets** of what it may do there. A profile is data the broker
reads, never code it runs. igloo ships `anthropic-messages`, `github`, `openrouter` and `runpod` as
profiles (below). Anything else is a profile you define, or import from someone who published one.
The one upstream policy places otherwise is a
[model server on this machine](#model-servers-on-this-machine), and only by its port.

### Defining and granting

Two separate acts, both in a policy layer.

**Defining** a profile makes it available by name and grants nothing:

```nix
{
  profiles.example = {
    placeholders = [ "EXAMPLE_API_KEY" ];
    hosts."api.example.com".send = "bearer";
    hosts."uploads.example.com".send.header = "x-upload-key";
    allow.read."api.example.com" = [
      {
        method = [
          "GET"
          "HEAD"
        ];
        path = "v1/**";
      }
    ];
    allow.write."api.example.com" = [
      {
        method = "POST";
        path = "v1/items";
      }
    ];
    allow.write."uploads.example.com" = [
      {
        method = "POST";
        path = "files";
      }
    ];
    deny."api.example.com" = [
      {
        method = "*";
        path = "v1/keys/**";
      }
    ];
  };
}
```

igloo's own profiles are defined in its package. The user layer may define its own, import a
published one (`programs.igloo.policy.profiles.example = inputs.someone.brokerProfiles.example;`),
or replace one of igloo's by defining its name: it is your machine. A project may define profiles
for itself and replace neither igloo's nor the user layer's, so a credential the user layer shares
cannot have its rules changed from a project's file. A profile is defined once per layer;
home-manager refuses a second definition of one name. igloo's are also the flake's `brokerProfiles`,
for reading or copying.

**Granting** is declaring a brokered credential for the profile, choosing its sets in `allow`, and
per repository in `repos` for a profile with repositories, and naming in `hosts` the hosts they
reach:

```nix
{
  secrets.example = {
    source.command = [
      "pass"
      "show"
      "example"
    ];
    mode = "broker";
    profile = "example";
    hosts = [ "api.example.com" ];
    allow = [ "read" ];
  };
}
```

`hosts` has to be exactly the hosts the chosen sets reach, ignoring case, or the launch is refused
and told which. It is written twice, in the profile and here, because where a key goes matters most:
a profile whose update moves a host fails here rather than sending your key there. A host no chosen
set reaches is not answered for the project at all. A credential the user layer declares may grant
igloo's profiles and the user layer's; one a project declares may grant its own as well.

### The format

- **`hosts.<host>.send`**, how the key is sent at that host: `"bearer"` for
  `Authorization: Bearer <key>`, `{ header = "<name>"; }` for one header whose whole value is the
  key, or `{ basic = "<username>"; }` for `Authorization: Basic` with that username. Never in a
  query or a path, which a server can echo into an error or a log. A header the broker drops, sets
  or frames a request by — `Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`,
  `Accept-Encoding`, the hop-by-hop ones — cannot carry a key. A host is a name with a dot, never an
  address, and reached over HTTPS on 443.
- **`placeholders`**, the variables the service's clients read a key from. Each is set in the guest
  to `igloo-broker-holds-the-real-key` for a project granted the profile, and the broker sends the
  real key in its place. A name ends in `_API_KEY`, `_KEY` or `_TOKEN`, so a profile cannot set
  `PATH` or `LD_PRELOAD`.
- **`allow.<set>.<host>`**, the rules of a set at one host. A set is what a grant chooses, so name
  sets for what they let the guest do.
- **`deny.<host>`**, rules that hold whatever sets are chosen. Deny wins over any set.
- **A rule** is a `method`, one, a list or `"*"` for any, and a `path`, segments where `*` is any
  one segment, a last `**` any number of them, none included, and `""` the host's root. Fixed
  segments are compared as written, since services match them by case. The path is compared as the
  request's is once every `.` and `..` is resolved; a path with a percent-escape or an empty segment
  is refused. The request's query goes with it, each name and value encoded again.
- **`graphql.withheld`** on a `POST` rule makes it a GraphQL request's: the broker reads the body
  and sends it only if it holds queries alone, no mutation or subscription, and names none of the
  fields listed, each one that would return a credential. The request has to be one JSON object of
  `query`, `variables` and `operationName`, at most 256 KiB, and goes as the object the broker read,
  written again as JSON, without the URL's query.
- **`length = "kept"`** on a rule sends a body with the `Content-Length` the guest stated, and holds
  it to that, for a service that takes an upload only with its length. Any other body goes in
  chunks.

For a service whose keys reach repositories, a forge:

- **`repository = { segments = 2; ignoreCase = true; };`** says what a repository is in the
  profile's paths: that many segments, as `owner/repo` is two, compared ignoring case where the
  service matches names so.
- **`{repo}`** in a rule's path is a repository, as `repos/{repo}/issues/**`. Such a rule applies to
  a repository whose list in the grant's `repos` holds its set, and the request goes upstream with
  the repository spelled as the grant spells it. A `deny` rule belongs to no set, so it names a
  repository by its segments, as `repos/*/*/hooks`, and refuses that for every one.
- **`{ git = "fetch"; }`** and **`{ git = "push"; }`** are git's reader, a rule of their own with no
  method or path: git's smart HTTP for `{repo}` at the rule's host, the ref advertisement and the
  fetch, or the advertisement a push asks for and the push, with or without `.git`. A push is
  refused at its advertisement as well as at the push. git's headers are built rather than carried,
  and a refused credential comes back as a `502`, so git does not ask for a password.
- **`hosts.<host>.redirects = "return"`** passes that host's redirects back to the guest,
  unfollowed, for a signed URL elsewhere that needs no credential, a log's or an asset's.
- **`hosts.<host>.pages = "github"`** is GitHub's exception, named for whose behaviour it is: GitHub
  names a listing's next page by the repository's number, and an answer for a request under `{repo}`
  has each such `Link` put back under the repository, so a client following it stays within the
  grant. It needs `repository`.

A set whose rules name a repository is chosen per repository, in `repos`; one whose rules name none
reaches the whole account, whatever the key reaches, and is chosen in `allow` alone. A set with both
applies its rules naming none when any repository lists it.

A field the format does not have is refused, not ignored, as is anything above written otherwise.

### Levels

What a set allows is plain from its rules:

- **The host alone:** `{ method = "*"; path = "**"; }`. Anything the key can do there.
- **The host, less a refusal list:** that, with `deny` rules beside it.
- **An allow-list:** anything narrower. igloo's profiles are allow-lists.

The worst a careless or hostile profile can do is let the guest use the key freely at hosts you
named in your own grant. That is the weakest level, and still better than `deliver`, where the guest
can copy the key and use it anywhere. Reviewing a profile you did not write means reading what the
sets you choose allow; reviewing an update means reading what changed. `igloo profile check` does
the reading against the service's own list of operations.

### Reviewing a profile against its spec

Most services publish an OpenAPI spec naming every operation they have. Given one, igloo lists what
a profile's sets actually allow, so you read operations rather than patterns:

```sh
curl -o runpod.json https://api.runpod.io/v2/openapi.json
igloo profile check runpod --spec runpod.json
```

The profile is named as `up` would find it: igloo's, the user layer's, or, run inside a project, the
project's. `--file profile.json` checks one that no layer defines, as JSON. `--spec` may be given
once for each spec the profile's hosts need. For each host it prints:

- **What each set allows**, operation by operation, grouped as the spec groups them (by its tags, or
  for GitHub by `x-github.category`). An operation in a group you did not expect a set to reach is
  the thing to look for: GitHub's `pulls/**` also reaches a Codespace made from a pull request,
  which is why igloo's `github` refuses it in `deny`.
- **The rules that match no operation**: a typo, or an API that moved. These fail the check.
- **The writes nothing allows or denies**, which is how you see what a service has added since the
  profile was written.
- **The level** the host comes to with every set chosen, as [above](#levels).

Every answer comes from the broker's own decision: each operation, with sample values in its path,
is put to the same code that decides a real request. Where a slot of the path may hold a `/` (a
file's path, say), the operation is asked about both ways, and one allowed only one way is marked.

To hold a profile to what you expect, write the groups each set is meant to reach as JSON and pass
them with `--groups`:

```json
{ "pods": ["Pods"], "templates": ["Templates"] }
```

An operation a set allows outside its groups fails the check, which exits non-zero. A set you leave
out is listed and not held to anything. `--unallowed` takes the writes nothing allows or denies, per
host, as `{ "api.runpod.io": [ "PUT v2/account/ssh-keys" ] }`: one it doesn't name fails, so a
refreshed spec that adds a write fails until someone has read it. Neither file is part of the
profile, which holds only what the broker enforces.

For a collection of profiles, the flake's `lib.profileCheck` builds the same check from a profile,
specs fetched by hash and the groups, for CI:

```nix
igloo.lib.profileCheck {
  name = "example";
  profile = import ./example.nix;
  specs = [
    {
      url = "https://api.example.com/openapi.json";
      hash = "sha256-…";
    }
  ];
  groups = {
    read = [ "Things" ];
    write = [ "Things" ];
  };
}
```

A spec may name `paths` to keep only those parts of it, as rule paths; a rule outside them is
reported as unchecked. A host no spec describes is reported as unchecked, not failed:
`api.anthropic.com`, which publishes no spec, and `github.com`, whose git traffic is no API
operation. A GraphQL endpoint is one operation whose reach is in its body, so a REST spec says
nothing about it either.

What it can't tell is whether a read is harmless. It lists every read a set allows, and only you can
say which of them matter: a field's name is no guide, as `license.key` is a licence's identifier and
no secret.

### What a profile cannot do

- **Send a key anywhere you did not name.** Its hosts are checked against your grant's `hosts`.
- **Reach past a `restricted` ceiling.** Where the user layer sets `networkCeiling = "restricted"`,
  each host a project's grant reaches through a profile has to be in `tunnelCeiling`, whichever
  layer defined the profile; igloo's own, as igloo ships them, are exempt.
- **Name an address, a port or plain HTTP.**
- **Read a body**, but GraphQL's, or follow a redirect: a redirect is refused, or passed back where
  a host returns them, and an upstream `401` comes back as the broker's `403` naming the credential.
- **Ask, budget or rate-limit.** A rule allows or denies.

Every profile host is answered by its own name. A client keeps its default address and needs only a
key, which the guest holds as a placeholder; see
[pointing an agent at the broker](#pointing-an-agent-at-the-broker).

## igloo's profiles

The profiles igloo ships, by name. Each grant below chooses every set, which is what a grant of it
did before profiles had sets; drop those a credential does not need.

### `anthropic-messages`

- **Hosts:** `api.anthropic.com`, with an Anthropic API key sent as `x-api-key`.
- **Sets:** `messages`, `POST v1/messages` and `POST v1/messages/count_tokens`. The key reaches
  whichever model a request names.
- **Placeholder:** `ANTHROPIC_API_KEY`.
- **Grant:** `hosts = [ "api.anthropic.com" ]; allow = [ "messages" ];`

### `openrouter`

- **Hosts:** `openrouter.ai`, with an OpenRouter API key sent as a bearer token.
- **Sets:** `models`, a model call in each of the three shapes agents speak:
  `POST api/v1/chat/completions`, `POST api/v1/responses` (OpenAI's Responses API, which OpenRouter
  keeps no state for) and `POST api/v1/messages` (Anthropic's Messages API); and the model listings
  `GET api/v1/models`, `api/v1/images/models`, `api/v1/videos/models` and
  `api/v1/embeddings/models`. The key reaches whichever model a request names.
- **Placeholder:** `OPENROUTER_API_KEY`.
- **Grant:** `hosts = [ "openrouter.ai" ]; allow = [ "models" ];`

The broker answers `openrouter.ai` for a project granted this profile, and that name is also
OpenRouter's website and documentation: a read no rule covers goes there without the key where the
project's `tunnel` reaches `openrouter.ai`, and is refused where it does not
([what the broker checks](#what-the-broker-checks)).

### `github`

- **Hosts:** `github.com`, over git's smart HTTP protocol, with the token in the username slot git
  uses for one, `x-access-token`; `api.github.com`, GitHub's REST and GraphQL APIs, with the token
  as a bearer token, its redirects passed back and its page links kept under the repository; and
  `uploads.github.com`, where a release's assets are uploaded, as a bearer token. A fine-grained
  personal access token or a GitHub App installation token is taken either way.
- **Repositories:** `owner/repo`, with or without `.git`, matched ignoring case, as GitHub matches
  them. The upstream names one as the grant spells it.
- **Sets, per repository:**
  - `fetch`: `git clone`, `git fetch` and `git pull`.
  - `push`: `git push`. A push to a repository not listed for it is refused at the first request git
    makes for it, before anything is sent.
  - `read`: through the REST API, with `GET` or `HEAD`, anything under `repos/<owner>/<repo>/`, with
    its query; and the API's root, where GitHub gives a token's scopes.
  - `issues`, `pulls` and `releases`: writing through the REST API anywhere under `issues/`,
    `pulls/` and `releases/`, with their comments, labels, reviews and merges, and, for `releases`,
    uploading an asset, `POST repos/<owner>/<repo>/releases/<id>/assets` at `uploads.github.com`,
    with its query, which names the asset. GitHub takes an asset only with its `Content-Length`, as
    `gh` sends it, and refuses one sent in chunks, so the length is kept.
  - `actions`: a run's rerun and cancel and a workflow's dispatch, at `actions/runs/<id>/rerun`,
    `rerun-failed-jobs`, `cancel` and `force-cancel`, `actions/jobs/<id>/rerun` and
    `actions/workflows/<id>/dispatches`.
  - `checks`: a commit's statuses and checks, at `statuses/<sha>`, `check-runs` and `check-suites`.
- **Sets, for the whole account:** `graphql`, `POST graphql`, whatever it reads or writes. It names
  repositories in its body, so it reaches whatever the token reaches, and is chosen in `allow`,
  never under a repository: see [what a grant does not bound](#what-a-grant-does-not-bound).
- **Refused whatever is chosen:** a Codespace made from a pull request,
  `repos/*/*/pulls/*/codespaces`, which `pulls` would admit: a machine of its own, billed to the
  token's account, running the pull request's branch. And, by omission, every write no set lists,
  even where the token could make it: a repository's settings, collaborators, webhooks, deploy keys,
  Actions secrets, variables and runners, its contents and refs and its labels; and everything
  outside `repos/` but the root and `graphql`, `gists`, `user/repos` and `search` among it.
- **Placeholder:** `GH_TOKEN`, for GitHub's CLI, `gh`, which makes no request without a token.
- **Grant:** a repository read and one worked on, with GraphQL for `gh`:

  ```nix
  {
    hosts = [
      "api.github.com"
      "github.com"
      "uploads.github.com"
    ];
    allow = [ "graphql" ];
    repos."alice/demo" = [
      "fetch"
      "read"
    ];
    repos."alice/tool" = [
      "actions"
      "checks"
      "fetch"
      "issues"
      "pulls"
      "push"
      "read"
      "releases"
    ];
  }
  ```

  A Nix `let` names a list several repositories share. A grant written before profiles, with
  `repos.read` and `repos.write`, is refused with the grant that keeps what it allowed written out:
  each repository it read with `fetch` and `read`, each it wrote with every set, and `graphql`.

- **In the guest:** `git` is installed, and its system configuration rewrites `git@github.com:` and
  `ssh://git@github.com/` URLs to `https://github.com/` for a grant choosing `fetch` or `push`. The
  broker answers the hosts the grant reaches itself: a connection to any of them through the
  [tunnel](network.md#the-tunnel) reaches the broker rather than GitHub, under every network mode
  and with no `tunnel` entry. So an ordinary GitHub URL just works, a remote reads as the URL it was
  cloned from, and `gh` finds its repository from it.

A project has at most one `github` credential: a request to the API may name no repository, so the
broker could not tell which of two pays. List every repository in the one.

A push to a repository listed for `push` reaches every branch and tag the token can write to. Which
ones it updates is in its body, which the broker does not read, so the bound is the repository's
own: its rulesets, such as no force-push and no deletion on `main`. A token acts as its account, so
the token of an account a ruleset lets bypass it bypasses it from the guest too. To keep an agent
off `main`, use a token of an account that is not on the bypass list. A GitHub App's installation
token expires within an hour, and the broker reads a credential only when the VM boots, so it does
not last a working session.

With `gh` in the guest, `gh auth status` works, and so do its commands that read a repository listed
for `read`: `gh run list`, `gh run view`, `gh release list`, `gh release view`, `gh repo view`,
`gh issue list`, `gh pr list`, and `gh api` under `repos/`. Those that read through GraphQL, as most
of `gh pr`, `gh issue` and `gh repo` do, need `graphql`, and reach whatever the token reaches,
listed or not; those that write through it, as `gh issue create`, `gh pr comment` and `gh pr merge`
do, work if the token can write. Without `graphql` they are refused. Those that write through the
REST API work for a repository listed for their set: `gh release create`, assets included,
`gh release upload`, `gh release edit` and `gh release delete` for `releases`, and `gh run rerun`,
`gh run cancel` and `gh workflow run` for `actions`. `gh label`, `gh run delete`,
`gh workflow enable` and `disable`, `gh cache delete`, `gh secret` and `gh variable` write what is
refused. So does deleting a ref through the API, which `gh release delete --cleanup-tag` and
`gh pr close --delete-branch` do after their own work: the release is deleted and the pull request
closed, and the tag or branch is left for `git push origin :<ref>` to delete. GitHub serves a run's
logs and a release's assets as redirects to signed URLs on other hosts, which the broker passes back
for the guest to follow through the tunnel; under `restricted`, list those hosts in `tunnel`.
`gh run view --log` and `--log-failed` read a run's log archive from
`results-receiver.actions.githubusercontent.com`, and `gh release download` reads an asset from
`release-assets.githubusercontent.com`.

GitHub names the next page of a repository's listing by the repository's number, which no grant
names. On an answer for a listed repository, the broker puts each such link back in the
`repos/<owner>/<repo>/` form, so `gh` paging through issues or runs stays within the grant.

Scope the token itself to the same repositories. The grant bounds what the broker asks for over git
and the REST API, and the token bounds what GitHub gives; a GraphQL query is bounded by the token
alone. With no repository listed for a writing set, make the token read-only. With one, the token
needs Contents write, which a fine-grained token holds for every repository it reaches, so a GraphQL
query can write to a repository listed only for `read` too. A repository that must not be written
belongs in a token that cannot write it, or in a grant without `graphql`.

### How the guest reaches a profile's hosts

The broker answers each host a project's grants reach over TLS with a certificate of its own, so the
guest has to trust what issued it. On the first launch with a grant, igloo makes a certificate
authority for the project with `openssl`, and a certificate signed by it for every host of the
profiles igloo ships, `github.com`, `api.github.com` and `uploads.github.com` among them, and for
the hosts of the user layer's and the project's profiles the project grants. It keeps both in
`.igloo/tls/`, with the certificate's key, readable only by you. The guest is built trusting that
authority beside the system's own, and `NODE_EXTRA_CA_CERTS` and `NIX_SSL_CERT_FILE` point Node, Bun
and Python at the same list.

- The authority can sign for those hosts and their subdomains, and nothing else: its name
  constraints say so, and its own key is deleted once it has signed the one certificate. What
  `.igloo/tls/` holds can answer those names to this project's guest, and sign nothing. The broker
  answers only the hosts its own grants reach.
- Every request the guest makes to any of them over HTTPS reaches the broker. What the grant covers
  is served with the key. A read no grant covers, a release download, a clone of a public repository
  the grant does not list or an install script's read through the API, is sent on with no credential
  at all, when the VM's tunnel could reach that name itself: under `internet`, or under `restricted`
  with the name in `tunnel`. A redirect in its answer comes back for the guest to follow through the
  tunnel. Anything else, a write no grant covers among it, is refused with the reason.
- `.igloo/tls/` is made again when it no longer covers the names the broker answers, or is within 30
  days of expiring after ten years. Delete it to have it made again; the next launch rebuilds the
  guest, since the authority is part of it.

With no repository listed for `push`, pushing happens from the host, in a repository the agent has
written. Before running `git` there, look at `.git/config` and `.git/hooks`: git runs what they
name, as you.

### `runpod`

- **Hosts:** `api.runpod.io`, Runpod's REST API under `v2/` and its GraphQL API at `graphql`, and
  `api.runpod.ai`, the API a serverless endpoint is called through. A Runpod API key is sent as a
  bearer token at both.
- **Sets:**
  - `read`: with `GET` or `HEAD`, anything under `v2/` at `api.runpod.io`, with its query: the GPU
    catalog with prices and availability, pods and their logs, templates, volumes, serverless
    endpoints, billing. And a GraphQL query, `POST graphql`, that only reads: a mutation is refused,
    since one can create an API key that the guest would then hold, and so is a query naming
    `registryAuth`, which holds a registry's login.
  - `pods`: creating, changing and deleting pods; starting, stopping, restarting and resetting one
    (`v2/pods/<id>/action`); running a command in a running pod, `POST v2/pods/<id>/exec`, which
    answers with its output and exit code after at most 25 seconds; and cancelling a queued pod.
  - `clusters`, `serverless`, `templates`, `volumes` (network and global volumes), `registries`
    (registry logins) and `secrets`: creating each, and changing and deleting one.
  - `invoke`: calling a serverless endpoint, `GET`, `HEAD` or `POST` anything under `v2/<endpoint>/`
    at `api.runpod.ai`, so `run`, `runsync`, `status`, `stream`, `cancel`, `retry`, `health`,
    `purge-queue`, and a vLLM worker's OpenAI-compatible API under `openai/v1/`.
  - Refused whatever is chosen: a write that reaches past what the account runs to who may use it,
    an organization's invitations, members, groups and roles, the account's SSH keys, sign-in
    attempts (each ends in a new API key), tags (cost centres are tags), cost centres and ECR
    delegations; any write no set names; and any path outside `v2/` and `graphql`.
- **Placeholder:** `RUNPOD_API_KEY`, which `runpodctl` and Runpod's other clients read their key
  from. `runpodctl` is yours to install in the guest, as any package is.
- **Grant:**
  `hosts = [ "api.runpod.ai" "api.runpod.io" ]; allow = [ "clusters" "invoke" "pods" "read" "registries" "secrets" "serverless" "templates" "volumes" ];`.
  A project that only watches the account chooses `allow = [ "read" ]` and
  `hosts = [ "api.runpod.io" ]`. Creating pods takes a key with **All** permissions: a **Read only**
  key reads, and **Restricted** sets access per serverless endpoint and nothing else.

`runpodctl` 3.1.1 uses the REST API at `api.runpod.io/v2`, but writes a few things through GraphQL,
and those commands are refused: `serverless create`, the parts of `serverless update` that change an
endpoint's template or models, and `model add` and `model remove`. The REST API does the first:
`POST v2/serverless` creates an endpoint. Adding an SSH key to the account (`ssh add-key`, and that
step of `doctor` and `config`) is `PUT v2/account/ssh-keys`, which is refused too. `runpodctl user`
reads the balance through GraphQL, and works.

A Runpod key reaches the whole account, so the bounds that matter most are Runpod's own:

- **Spending.** Nothing on the key caps what it spends. The account's balance does, with automatic
  top-up off, and so does its hourly spend limit. Keep on the account only what you would let an
  agent spend.
- **What a pod does.** A pod is a machine with its own network. What the guest puts in a template, a
  container image, a start command, environment variables, goes wherever the pod sends it, so under
  `restricted` a pod is a way around the VM's [network mode](network.md#network-modes).
- **What the account holds.** A read through either API returns what the account holds in plain
  text, an environment variable of any template, pod or endpoint among it, and a GraphQL query reads
  whatever a query can. Keep a value that matters in a Runpod secret, which no read returns, and
  give it to a pod by reference.

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
    models = [ "Qwen3.5-0.8B" "Qwen3.5-2B" ];
    projects = [ "${config.home.homeDirectory}/projects/demo" ];
  };
}
```

| Field      | Value                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `port`     | The port the server listens on at `127.0.0.1`.                                                                |
| `key`      | Only for a server that requires one: `{ file = "…"; }` or `{ command = [ … ]; }`.                             |
| `models`   | The only models a call may name, as the server names them. Unset, a call may name any.                        |
| `projects` | User layer only: the projects' root directories, as for [`secrets`](#in-the-user-layer-for-several-projects). |

The name, `llama-swap` above, is lowercase letters, digits and `-`. It is part of the URL the guest
uses, and names the server in the broker's log. One name declared in both layers is refused. A `key`
is read the way a credential's [source](#sources) is, under the same rules.

- **Upstream:** `http://127.0.0.1:<port>`. The address is always this machine's loopback, so no
  setting can send a request anywhere else, and a `host`, `url` or any other field is refused. The
  server has to listen on `127.0.0.1`: one listening only on `::1` is not reached.
- **Endpoints:** `POST v1/chat/completions`, `POST v1/responses`, `POST v1/embeddings` and
  `GET v1/models`, which OpenAI-compatible servers share; `POST v1/rerank`, the reranking llama.cpp
  serves; and `POST v1/systemone`, llama.cpp's call of a decision model, which llama-swap passes on
  from v262. Nothing else, and one path for each: a server's aliases for the same call, such as
  `v1/reranking`, are refused. A server's other endpoints are not model calls: llama-swap's other
  endpoints read other clients' recorded requests and its logs, unload models, and pass any request
  through to the server behind it; llama-server's own save its state to files and restore it, load
  and unload models, and change its settings.
- **Models:** with `models`, the broker reads each call's body and refuses one whose `model` is not
  listed, comparing names exactly, with a `403` naming the model, before the server sees it.
  `GET v1/models` then lists only those. A call is read whole, up to 8 MiB, and refused past that
  with a `413`. So that the broker and the server read the same call, it is refused unless it is
  sent as `application/json`, with no parameter but `charset=utf-8` and no `Content-Encoding`, and
  is one JSON object in UTF-8, with no byte-order mark, no key named twice in any object, and a
  `model` that is a string. The broker's log names the model of each call, passed or refused.
  Without `models`, the body is streamed to the server unread.
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

- **Models.** Without `models`, a request may name any model the server has, and loading one costs
  this machine's memory. A server that loads models on demand, as llama-swap does, loads whichever
  is named, and may stop the model another client is using to do it. Set `models` to the ones the VM
  may load: llama-swap has no way to limit one client to some of its models. With `models` set, a
  listed name is still the server's to resolve: an alias on it in the server's configuration loads
  whatever the alias points to.
- **Fetches.** Some servers reach the network for a request, from this machine: past the tunnel's
  address checks, LAN included. llama-server downloads an image, audio or video given as an
  `http(s)` URL, in a chat message or an embedding or reranking input, when it runs with a
  multimodal projector (`--mmproj`); from build b12340 it refuses local and private addresses unless
  it runs with `--media-allow-private-urls`. llama-swap sends a model listed under its `peers` to
  the remote server named there. Under `restricted`, workspace data can leave that way. Run the
  server without these if that matters.
- **Files.** llama-server run with `--media-path` reads a file under that directory, on this
  machine, for a `file://` URL in the same places, and gives it to the model. Run it without
  `--media-path`, or point it at a directory the guest may read.

### Pointing an agent at a model server

An agent reaches a model server at `http://127.0.0.1:3128/local/<name>/v1`, where `<name>` is the
server's name in `modelServers`. The guest sets no variable for it; each agent is given the base in
its own configuration:

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

The broker decides from a request's method, its path and the name it was sent to where it goes and
which credential it carries. It does not read the body, which it streams upstream as it arrives, but
for a GraphQL request at a rule that reads one, as Runpod's does, to refuse a mutation
([`runpod`](#runpod)), and a call to a model server whose `models` are listed, to refuse a model not
listed ([model servers](#model-servers-on-this-machine)). So **the model** is not checked at a
provider: any model passes, or none, with whatever `max_tokens` the request sets. Nor are **the
provider's own tools**: a request may ask for web search, web fetch, code execution or an MCP
connector, use OpenRouter's plugins or a `:online` model, or give an image by URL for the provider
to download, under every [network mode](network.md#network-modes).

What a provider does on a model's behalf is the provider's. Under `restricted` that means workspace
data can leave through a provider-side tool to any address, past the destinations `tunnel` lists.
Turn those tools off in the provider's settings or the agent's own if that matters.

On every brokered request:

- The guest's `Authorization`, `x-api-key`, `Proxy-Authorization` and `Cookie` are dropped, and the
  broker sets its own credential.
- On a profile's host or a model server, the guest's other headers pass, `anthropic-version`,
  `anthropic-beta`, `x-session-id` and `X-GitHub-Api-Version` included. Those about the guest's
  connection do not: `Host`, `Connection` and the headers it names, the other hop-by-hop ones, and
  `Expect`. Nor do those a server in front of the upstream could take another method, path or origin
  from: `X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Original-URL`,
  `X-Rewrite-URL`, `Forwarded`, `X-Forwarded-For`, `-Host`, `-Port`, `-Prefix` and `-Proto`, and
  `X-Real-IP`. Nor do `Accept-Encoding` and `Content-Length`, which the broker sets itself: a body
  goes in chunks, but at a rule that keeps its length, a release's asset among them, where one sent
  with a `Content-Length` and no `Transfer-Encoding` goes with that length and is cut off if it runs
  past it or ends short. A `GET` or `HEAD` carries no `Content-Type` or `Content-Encoding` either.
  The broker's key is set as the profile says, replacing a header of the same name the guest sent.
  On git's requests, the broker builds the headers and carries over only git's protocol version and
  request-body encoding, each checked first. A GraphQL request a rule reads goes as
  `Content-Type: application/json`, the body the broker wrote. A request to a profile's host arrives
  over TLS and names no host in its path, so the host it was sent to is read instead, and only the
  names the project's grants reach are answered.
- A read no rule covers at a name the broker answers, a `GET` or `HEAD` or git's fetch, goes on
  without any credential where the project's `tunnel` reaches that name, as it would have had the
  broker not answered it; so does a read a profile's `deny` rule matches. Where the tunnel does not
  reach the name it is refused, as is a write no rule covers.
- The response passes back with its status and body. On a profile's host or a model server, its
  headers pass too, `retry-after`, rate limits and request ids included, except `Set-Cookie`,
  `WWW-Authenticate`, `Proxy-Authenticate`, `Alt-Svc`, `Content-Length`, `Content-Encoding` and the
  hop-by-hop ones. On git's, `Content-Type` is its only header.
- An upstream `401` comes back saying the host's credential was refused: as a `403` on a profile's
  host or a model server, which a client reports at once rather than retrying, and as a `502` on
  git's requests, so that git does not prompt for credentials the guest must not have. A redirect is
  not followed. One from a host whose profile returns them, GitHub's API, comes back to the guest,
  which follows it to a signed URL elsewhere without the credential.
- A refusal the broker writes itself at a profile's host is JSON, `{"message":"broker: <reason>"}`,
  as GitHub writes an error of its own, and `gh` shows it as
  `HTTP <status>: broker: <reason> (<URL>)`; `runpodctl` reads the same field. At one of git's
  endpoints, and on the broker's own port, it is text, `broker: <reason>`, which git prints as
  `remote: broker: …`.
- Every refusal the broker writes itself carries `x-should-retry: false`, except the one that may
  pass: an upstream that did not answer.
- No request body is refused for its size, but the two the broker reads whole: a GraphQL request a
  rule reads, refused past 256 KiB, and a call to a model server whose `models` are listed, refused
  past 8 MiB. The upstream's own limit is the one a body meets, and at a profile's host the
  upstream's refusal comes back as it gave it. A call is given up on when its upstream has not
  answered within 10 minutes of any request to a profile's host or a model server, or 30 seconds of
  a read no grant covers, or when the guest leaves before it answers; a body still being sent then
  is cut off.
- The broker serves as many requests and tunnels at once as the guest opens. Its memory is not
  bounded unless you set `brokerMem`; see [Configuration](configuration.md#policy-settings) and
  [when the broker is killed](troubleshooting.md#when-the-broker-is-killed).

## What a grant does not bound

- **What is sent.** A grant to call a model is a grant to send it anything the guest can read.
- **Models and spend.** A model grant reaches every model the key does, for as many requests as the
  guest makes. Limits on the key itself, at the provider, are the only bound on either.
- **The provider's tools.** A model grant reaches every tool the provider runs for a model, and
  those reach whatever the provider reaches.
- **GitHub's GraphQL API.** A `github` grant choosing `graphql` sends every GraphQL query with its
  token, reads and writes alike, for whatever repository the query names. A query names repositories
  in its body, which the broker does not read, and much of it by IDs that say which repository they
  belong to only after a lookup, so not even reading it could bound one to the repositories listed.
  The token's own permissions are all that bound it: scope a fine-grained token to exactly the
  repositories listed, with no permission you would not give the agent.
- **Which refs a push updates.** A push to a repository listed for `push` reaches every branch and
  tag the token can write to. The repository's rulesets bound it, and the grant does not.
- **What a write through the REST API sets.** A write is allowed by its method and its path, and
  what it sets is in its body. A merge lands on whatever branch the pull request targets, and a
  release creates the tag it names, on the commit it names. The repository's rulesets bound those,
  as they bound a push.
- **What a Runpod account spends and runs.** A `runpod` grant reaches every GPU the account can
  rent, and every pod it creates reaches its own network with whatever the guest gave it. The
  account's balance bounds the first; nothing the broker does bounds the second
  ([`runpod`](#runpod)).
- **What a Runpod read returns.** Either API returns what the account holds in plain text,
  environment variables included, to a read the grant allows.

## Pointing an agent at the broker

The broker answers each host of a granted profile by that host's own name, so an agent keeps its
default address: Claude Code reaches `api.anthropic.com`, an OpenRouter client `openrouter.ai`,
`runpodctl` `api.runpod.io`. The tunnel hands a connection for one of those names to the broker,
which answers with a certificate from an authority made for the project and trusted in the guest. An
agent needs only a key, and the guest holds a placeholder in each variable the profile names
(`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `RUNPOD_API_KEY`), which the broker replaces with the
real key. An agent that reads its key only from its own file needs any text there. A model server is
covered in [pointing an agent at a model server](#pointing-an-agent-at-a-model-server), and a
`github` grant needs no pointing: `git` and `gh` reach GitHub by its own names, as
[`github`](#github) says.

The client has to trust the project's authority. Most read the system's store, which holds it. Node
and Bun read `NODE_EXTRA_CA_CERTS`, and Python clients that use certifi's list, as `requests` and
`httpx` do, read `NIX_SSL_CERT_FILE`; the guest sets both to that store. A client that verifies
against a list of its own and reads no variable does not reach the broker.

A login and a service the guest's NixOS configuration defines, in `systemd.services` or
`systemd.user.services`, are given the same variables: the proxy's, the two above, and the
placeholders. A process started some other way, by `systemd-run` say, inherits only what started it.

An agent that speaks Anthropic's Messages API can use an `openrouter` grant too: Claude Code, for
one, with `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and any key in `ANTHROPIC_API_KEY`, set in
`~/.bash_profile`. With an `anthropic-messages` grant as well, Claude Code reaches Anthropic by its
own name instead.

A project that brokers an Anthropic key uses it for all its Anthropic traffic: the broker answers
`api.anthropic.com` for the guest, and Claude Code leaves a subscription login unused while
`ANTHROPIC_API_KEY` is set. A project that wants the subscription does not broker the key.

An agent's upstream needs no `tunnel` entry, even under `restricted`. The broker reaches it itself.

Each refusal is recorded in the broker's log, with its reason:

```sh
tail -f .igloo/logs/latest/broker.log
```

The log is in the boot record of the launch that started the broker, which is usually `latest`. It
has one JSON line per event: `listening` as the broker starts, with the credentials it holds by name
and its grants, a profile grant's sets and hosts among them, and `tunnel-listening` with the
tunnel's destinations; `allow` with the credential if there is one, and the profile, the set and the
rule that allowed it, and the repository for a rule naming one, or for a model server the server;
`deny` with the reason and status, and what the request asked for when the reason names it;
`response` with the status, bytes and time taken; `error` when the upstream could not be reached or
refused the credential; and `tunnel-open`, `tunnel-close` and `tunnel-deny` for each tunnel, with
the destination it asked for. It never contains a credential's value.

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

- A service is brokered through a profile, igloo's or one a layer defines; a model server on another
  machine cannot be brokered. A profile sends a key in a header, never signs a request or refreshes
  a login, so a service whose key works only that way is out of reach.
- Each of igloo's profiles serves only the endpoints listed. Anthropic's model listing, and file and
  batch endpoints, are not served.
- `restricted` stops at the provider. A model call can have the provider fetch a URL, search the web
  or connect to an MCP server, and the provider reaches any address it likes, so workspace data can
  leave that way.
- Claude Code through `anthropic-messages` is untested against Anthropic itself. The broker passes
  its requests on as described above, but none has yet been sent to Anthropic with a real key, so it
  may not work.
- The broker verifies an upstream's certificate against the root certificates bundled with Bun,
  which it runs on, and no others. A certificate authority the host trusts, through
  `security.pki.certificates` or otherwise, does not reach it, so behind a proxy that intercepts TLS
  every request to a profile's upstream fails verification. The tunnel does not open the TLS it
  carries, so there the guest's own client does the verifying, and a content module can give the
  guest the authority with `security.pki.certificates`.
- The broker starts with none of your user manager's environment: `igloo up` reads the names in it
  and has the broker's unit unset them. A variable added to it after that reaches the broker when
  systemd starts it again on its own, after it is killed for memory, say, until the VM is next
  launched.
- `github` pushes and writes through the REST API only for a repository listed for a set that does,
  and through the REST API writes only what its sets list. Its GraphQL API, where `graphql` is
  chosen, is passed with the token, and the grant does not bound what a query reads or writes.
- With a `github` grant, nothing in the guest reaches the hosts its sets reach but through the
  broker. Under `restricted` without them in `tunnel`, that means only the repositories listed: a
  release download from `github.com`, a clone of any other repository, or an anonymous read through
  the API, is refused.
- Under `restricted`, one job's log, read through the API at `actions/jobs/<id>/logs`, is out of
  reach. GitHub redirects it to one of a set of numbered storage hosts,
  `productionresultssa<n>.blob.core.windows.net`, which differs from job to job, and `tunnel` names
  hosts exactly. A whole run's log archive comes from one host that can be listed.
- A path holding a percent-escape is refused, so an API read naming a branch with a `/` in it, as
  `branches/feature%2Fx`, is refused.
- A client that verifies against a list of certificate authorities of its own, rather than the
  system's, does not trust the broker's, and fails to reach any name the broker answers. Node and
  Bun read `NODE_EXTRA_CA_CERTS`, and certifi `NIX_SSL_CERT_FILE`, which the guest sets; point any
  other at `/etc/ssl/certs/ca-certificates.crt`.
- With a grant of a profile, nothing in the guest reaches its hosts but through the broker: a read
  no rule covers goes without the key where `tunnel` reaches the host, and is refused where it does
  not.
- `runpod` reaches a pod by its API alone: a command runs in it through `POST v2/pods/<id>/exec`,
  and waits at most 25 seconds for it. SSH to a pod uses port 22 at an address, which the
  [tunnel](network.md#the-tunnel) does not carry, so `runpodctl ssh` does not connect, and neither
  do `runpodctl send` and `receive`, whose relays are on other ports. A pod's HTTP ports, at
  `<pod>-<port>.proxy.runpod.net`, are reached through the tunnel under `internet`, and under
  `restricted` only by listing each pod's name, since `tunnel` takes no wildcards. A network
  volume's S3 API takes keys of its own, which sign each request, so the broker cannot hold them.
- `runpod` refuses every GraphQL mutation, so a client that writes through GraphQL is refused where
  the REST API would have done the same write: `runpodctl serverless create`, among others
  ([`runpod`](#runpod)).
- A serverless endpoint of the load-balancing kind is called at a name of its own,
  `<endpoint>.api.runpod.ai`, which the broker does not answer.
- Runpod's hosted MCP server, `mcp.runpod.io`, is not brokered: every operation of the REST API is
  one of its tools, those `runpod` refuses among them, and which one a request calls is in its body.
  Signing in to it from the guest puts a token there, as any
  [login inside the guest](#logins-inside-the-guest) does.
- A credential's value is read only when the VM boots.
