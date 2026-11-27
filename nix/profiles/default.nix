# The broker profiles igloo ships: data the broker reads, each saying where a
# service's key goes and naming sets of what it may do there. Defining one
# grants nothing; a project's brokered credential chooses its sets. The CLI
# reads these beneath the user layer's, as JSON from its own package, and the
# flake exports them as `brokerProfiles` for anyone to read or copy.
{
  anthropic-messages = import ./anthropic-messages.nix;
  github = import ./github.nix;
  openrouter = import ./openrouter.nix;
  runpod = import ./runpod.nix;
  runpod-mcp = import ./runpod-mcp.nix;
}
