# Runpod's hosted MCP server, mcp.runpod.io, which takes the account's API key
# as a bearer token and calls Runpod's APIs with it for each tool. Every
# operation of the REST API is a tool, so the sets here are `runpod`'s, named
# by tool rather than by path: a tool is in the set that allows the request it
# makes. Left out, so refused whatever is chosen, is what `runpod` leaves out:
# an organization's members, invitations, groups and roles, the account's SSH
# keys, tags, cost centres and ECR delegations; and any tool the server adds
# until it is listed here.
#
# The server answers at its root. A client needs no key of its own: the broker
# sends the account's. Its guides are read through `read-guide` rather than
# as resources, whose names change with every release of the guides.
{
  hosts."mcp.runpod.io".send = "bearer";

  # What the account holds, and Runpod's documentation: every generated tool that
  # reads through the REST API, the catalog and the Hub, logs, and the guides.
  allow.read."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "describe-tool"
        "get-account"
        "get-account-limits"
        "get-balance"
        "get-capacity"
        "get-catalog-repo"
        "get-catalog-repo-readme"
        "get-catalog-template"
        "get-cluster"
        "get-cost-center"
        "get-cpu-type"
        "get-data-center"
        "get-endpoint"
        "get-endpoint-build"
        "get-endpoint-cold-start-metrics"
        "get-endpoint-request-metrics"
        "get-endpoint-worker-metrics"
        "get-global-volume"
        "get-gpu-type"
        "get-network-volume"
        "get-organization"
        "get-organization-group"
        "get-organization-invite"
        "get-organization-role"
        "get-organization-role-capabilities"
        "get-organization-user"
        "get-pod"
        "get-public-template-readme"
        "get-queued-pod"
        "get-registry"
        "get-secret"
        "get-ssh-keys"
        "get-tag"
        "get-template"
        "get-template-readme"
        "list-audit-logs"
        "list-billing"
        "list-catalog-repos"
        "list-cluster-billing"
        "list-cluster-pods"
        "list-clusters"
        "list-cost-center-resources"
        "list-cost-centers"
        "list-cpu-types"
        "list-data-centers"
        "list-delegations"
        "list-endpoint-billing"
        "list-endpoint-builds"
        "list-endpoint-releases"
        "list-endpoint-workers"
        "list-endpoints"
        "list-global-volumes"
        "list-gpu-types"
        "list-guides"
        "list-hub-repos"
        "list-network-volume-billing"
        "list-network-volumes"
        "list-organization-group-members"
        "list-organization-groups"
        "list-organization-invites"
        "list-organization-roles"
        "list-organization-users"
        "list-pod-billing"
        "list-pods"
        "list-public-endpoints"
        "list-public-templates"
        "list-queued-pods"
        "list-registries"
        "list-secrets"
        "list-serverless-billing"
        "list-tag-resources"
        "list-tags"
        "list-templates"
        "lookup-concept"
        "read-guide"
        "search-concepts"
        "search-docs"
        "stream-pod-logs"
        "stream-worker-logs"
      ];
    }
    {
      method = [
        "DELETE"
        "GET"
      ];
      path = "";
    }
  ];

  # Creating, changing, acting on and deleting pods, and running a command in
  # one, as `runpod`'s `pods` set allows them through the REST API.
  allow.pods."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-pod"
        "delete-pod"
        "delete-queued-pod"
        "exec-pod"
        "pod-action"
        "update-pod"
      ];
    }
  ];

  allow.clusters."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-cluster"
        "delete-cluster"
        "update-cluster"
      ];
    }
  ];

  # Creating, changing and deleting serverless endpoints. `deploy-hub-repo`
  # creates one from a Hub repository, through a GraphQL mutation `runpod` would
  # refuse, to the same end as `create-endpoint`.
  allow.serverless."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-endpoint"
        "delete-endpoint"
        "deploy-hub-repo"
        "set-endpoint-gpus"
        "update-endpoint"
      ];
    }
  ];

  allow.templates."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-template"
        "delete-template"
        "update-template"
      ];
    }
  ];

  allow.volumes."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-global-volume"
        "create-network-volume"
        "delete-global-volume"
        "delete-network-volume"
        "update-global-volume"
        "update-network-volume"
      ];
    }
  ];

  allow.registries."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-registry"
        "delete-registry"
        "update-registry"
      ];
    }
  ];

  allow.secrets."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "create-secret"
        "delete-secret"
        "update-secret"
      ];
    }
  ];

  # A serverless endpoint's own calls: running and cancelling jobs, and reading
  # their status, output and the endpoint's health.
  allow.invoke."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "cancel-job"
        "endpoint-health"
        "get-job-status"
        "purge-endpoint-queue"
        "retry-job"
        "run-endpoint"
        "runsync-endpoint"
        "stream-job"
      ];
    }
  ];

  # Runpod's agent-learning tools, which send what the agent writes from the
  # conversation to Runpod for review, and read back the account's earlier
  # notes into the agent's context. Chosen apart from everything else.
  allow.feedback."mcp.runpod.io" = [
    {
      method = "POST";
      path = "";
      mcp.tools = [
        "ask_question"
        "read_journal"
        "report_feedback"
        "save_to_journal"
      ];
    }
  ];
}
