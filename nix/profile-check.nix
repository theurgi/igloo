# `lib.profileCheck`: a broker profile checked against its service's spec,
# as a derivation that builds only if `igloo profile check` passes. For a
# collection's CI, which may fetch a spec; igloo's launch never builds one.
#
#   profileCheck {
#     name = "example";
#     profile = import ./example.nix;
#     specs = [ { url = "https://api.example.com/openapi.json"; hash = "sha256-…"; } ];
#     groups = { read = [ "Things" ]; write = [ "Things" ]; };
#     unallowed = { "api.example.com" = [ "POST v1/keys" ]; };
#   }
#
# `specs` are fetched by hash and indexed whole, or kept to `paths` where
# one names them, as `scripts/spec-index.ts --path` keeps them; `indexes`
# are indexes that script made. `groups` and `unallowed` are the reviewer's,
# as `--groups` and `--unallowed` read them, and either may be left out.
# The derivation's output is the report.
{
  cli,
  lib,
  pkgs,
}:
let
  # The script and the module it runs, and nothing else of the checkout, so
  # an index is made again only when what makes it changes.
  indexer = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ../scripts/spec-index.ts
      ../src/SpecIndex.ts
    ];
  };

  indexOf =
    name: at:
    {
      url,
      hash,
      paths ? null,
    }:
    pkgs.runCommandLocal "igloo-spec-index-${name}-${toString at}.json"
      {
        spec = pkgs.fetchurl { inherit url hash; };
      }
      ''
        ${pkgs.bun}/bin/bun ${indexer}/scripts/spec-index.ts \
          --source ${lib.escapeShellArg url} \
          ${
            lib.concatMapStringsSep " " (path: "--path ${lib.escapeShellArg path}") (
              if paths == null then [ ] else paths
            )
          } \
          "$spec" > $out
      '';
in
{
  name,
  profile,
  specs ? [ ],
  indexes ? [ ],
  groups ? null,
  unallowed ? null,
}:
let
  json = file: value: pkgs.writeText file (builtins.toJSON value);
  # In a directory of its own, so the file is named for the profile alone,
  # which is the name the command gives it.
  args = [
    "--file"
    "${pkgs.writeTextDir "${name}.json" (builtins.toJSON profile)}/${name}.json"
  ]
  ++ lib.concatMap (index: [
    "--index"
    index
  ]) (lib.imap0 (indexOf name) specs ++ indexes)
  ++ lib.optionals (groups != null) [
    "--groups"
    (json "${name}-groups.json" groups)
  ]
  ++ lib.optionals (unallowed != null) [
    "--unallowed"
    (json "${name}-unallowed.json" unallowed)
  ];
in
pkgs.runCommandLocal "igloo-profile-check-${name}" { } ''
  ${lib.getExe cli} profile check ${lib.escapeShellArgs (map (arg: "${arg}") args)} > $out || {
    cat $out
    exit 1
  }
''
