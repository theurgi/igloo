# Runpod: an account's REST API and its GraphQL at api.runpod.io, and the
# API its serverless endpoints are called through at api.runpod.ai.
#
# Each write set creates, changes and removes one kind of thing the account
# runs or keeps. Left out, so refused whatever is chosen, is what reaches
# past what the account runs to who may use it and how: an organization's
# members, invitations, groups and roles; the SSH keys every pod lets in;
# sign-in attempts, each ending in a new API key; tags, among which cost
# centres are kept; cost centres themselves; and ECR delegations, each
# registering a repository in an AWS account for Runpod to pull images from.
{
  placeholders = [ "RUNPOD_API_KEY" ];
  hosts."api.runpod.io".send = "bearer";
  hosts."api.runpod.ai".send = "bearer";

  # What the account holds: REST reads, and GraphQL queries naming no
  # registry's login. A mutation can mint the account a key, so GraphQL is
  # read and never written through.
  allow.read."api.runpod.io" = [
    {
      method = [
        "GET"
        "HEAD"
      ];
      path = "v2/**";
    }
    {
      method = "POST";
      path = "graphql";
      graphql.withheld = [ "registryAuth" ];
    }
  ];
  # A command run in a pod reaches what the pod does, which its start
  # command reaches already.
  allow.pods."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/pods";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/pods/*";
    }
    {
      method = "POST";
      path = "v2/pods/*/action";
    }
    {
      method = "POST";
      path = "v2/pods/*/exec";
    }
    {
      method = "DELETE";
      path = "v2/queued-pods/*";
    }
  ];
  allow.clusters."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/clusters";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/clusters/*";
    }
  ];
  allow.serverless."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/serverless";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/serverless/*";
    }
  ];
  allow.templates."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/templates";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/templates/*";
    }
  ];
  allow.volumes."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/network-volumes";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/network-volumes/*";
    }
    {
      method = "POST";
      path = "v2/global-volumes";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/global-volumes/*";
    }
  ];
  allow.registries."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/registries";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/registries/*";
    }
  ];
  allow.secrets."api.runpod.io" = [
    {
      method = "POST";
      path = "v2/account/secrets";
    }
    {
      method = [
        "DELETE"
        "PATCH"
      ];
      path = "v2/account/secrets/*";
    }
  ];
  # A serverless endpoint's own calls, under v2/<endpoint>/, which reach
  # nothing of the account but that endpoint.
  allow.invoke."api.runpod.ai" = [
    {
      method = [
        "GET"
        "HEAD"
        "POST"
      ];
      path = "v2/*/*/**";
    }
  ];
}
