# GitHub: git's smart HTTP at github.com, its REST API and GraphQL at
# api.github.com, and a release's assets at uploads.github.com.
#
# A repository is `owner/repo`, matched as GitHub matches it, ignoring case.
# A grant lists repositories in `repos`, each with the sets that apply there,
# and chooses `graphql` in `allow`, since a GraphQL request names what it
# reads and writes in its body, some of it by node IDs, and so reaches
# whatever the token reaches.
#
# The writes are what GitHub's CLI makes: issues and pull requests, with
# their comments, labels, reviews and merges; releases and their assets; a
# workflow run's rerun and cancel, and a workflow's dispatch; and a commit's
# statuses and checks. Left out, so refused whatever is chosen, is the rest
# of what a token that writes a repository may write, each of which reaches
# past the repository: its settings, collaborators, webhooks, deploy keys,
# Actions secrets and variables, and runner registration, to the people it
# lets in, the hosts a webhook calls, the machines a key opens, or the jobs a
# runner is given.
let
  writes = [
    "DELETE"
    "PATCH"
    "POST"
    "PUT"
  ];
in
{
  repository = {
    segments = 2;
    ignoreCase = true;
  };
  placeholders = [ "GH_TOKEN" ];
  # git takes a fine-grained token or an App installation's in the username
  # slot it uses for them.
  hosts."github.com".send.basic = "x-access-token";
  # A log's or an asset's download redirects to a signed URL elsewhere,
  # which needs no credential: the guest follows it. A listing's next page
  # is named by the repository's number, and is put back under the
  # repository the request named.
  hosts."api.github.com" = {
    send = "bearer";
    redirects = "return";
    pages = "github";
  };
  hosts."uploads.github.com".send = "bearer";

  allow.fetch."github.com" = [ { git = "fetch"; } ];
  allow.push."github.com" = [ { git = "push"; } ];
  # The API's root names its endpoints and, asked with a token, that token's
  # scopes, which is what `gh auth status` reads.
  allow.read."api.github.com" = [
    {
      method = [
        "GET"
        "HEAD"
      ];
      path = "";
    }
    {
      method = [
        "GET"
        "HEAD"
      ];
      path = "repos/{repo}/**";
    }
  ];
  # Unread: the token alone bounds it.
  allow.graphql."api.github.com" = [
    {
      method = "POST";
      path = "graphql";
    }
  ];
  allow.issues."api.github.com" = [
    {
      method = writes;
      path = "repos/{repo}/issues/**";
    }
  ];
  allow.pulls."api.github.com" = [
    {
      method = writes;
      path = "repos/{repo}/pulls/**";
    }
  ];
  allow.releases."api.github.com" = [
    {
      method = writes;
      path = "repos/{repo}/releases/**";
    }
  ];
  # GitHub takes an asset only with its length, and refuses one sent in
  # chunks.
  allow.releases."uploads.github.com" = [
    {
      method = "POST";
      path = "repos/{repo}/releases/*/assets";
      length = "kept";
    }
  ];
  allow.actions."api.github.com" = [
    {
      method = "POST";
      path = "repos/{repo}/actions/jobs/*/rerun";
    }
    {
      method = "POST";
      path = "repos/{repo}/actions/runs/*/cancel";
    }
    {
      method = "POST";
      path = "repos/{repo}/actions/runs/*/force-cancel";
    }
    {
      method = "POST";
      path = "repos/{repo}/actions/runs/*/rerun";
    }
    {
      method = "POST";
      path = "repos/{repo}/actions/runs/*/rerun-failed-jobs";
    }
    {
      method = "POST";
      path = "repos/{repo}/actions/workflows/*/dispatches";
    }
  ];
  allow.checks."api.github.com" = [
    {
      method = "POST";
      path = "repos/{repo}/check-runs";
    }
    {
      method = "PATCH";
      path = "repos/{repo}/check-runs/*";
    }
    {
      method = "POST";
      path = "repos/{repo}/check-runs/*/rerequest";
    }
    {
      method = "POST";
      path = "repos/{repo}/check-suites";
    }
    {
      method = "POST";
      path = "repos/{repo}/check-suites/*/rerequest";
    }
    {
      method = "POST";
      path = "repos/{repo}/statuses/*";
    }
  ];

  # A Codespace made from a pull request, which `pulls` admits: a machine of
  # its own, billed to the token's account and open to the internet, that
  # runs the pull request's branch with whatever Codespaces secrets the
  # account gives the repository. A deny rule belongs to no set, so it names
  # any repository by its two segments rather than by `{repo}`.
  deny."api.github.com" = [
    {
      method = writes;
      path = "repos/*/*/pulls/*/codespaces";
    }
  ];
}
