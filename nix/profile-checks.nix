# The broker profiles igloo ships, each checked against the index of its
# service's spec under `specs/`, with the groups each set is meant to reach
# and the writes nothing allows, as they were read, beside it. A profile
# with no index there is checked all the same, and its hosts reported
# unchecked.
#
# Then three changes the check has to fail on, each held to failing for
# that reason: a set reaching a group outside its own, a misspelt pattern,
# and a write added to a spec that nothing allows or denies.
{
  lib,
  pkgs,
  profileCheck,
}:
let
  profiles = import ./profiles;
  specs = ../specs;

  # What `specs/` holds for the profile `name`: its index, its groups and
  # its unallowed writes, each where there is one.
  reviewOf =
    name:
    let
      file = suffix: specs + "/${name}${suffix}.json";
      where = suffix: lib.optionalAttrs (builtins.pathExists (file suffix));
    in
    {
      indexes = lib.optional (builtins.pathExists (file "")) (file "");
    }
    // where ".groups" { groups = lib.importJSON (file ".groups"); }
    // where ".unallowed" { unallowed = lib.importJSON (file ".unallowed"); };

  checkOf = name: profile: profileCheck ({ inherit name profile; } // reviewOf name);

  # `check` has to fail, and with `expected` among what it says.
  fails =
    name: expected: check:
    pkgs.runCommandLocal "igloo-check-${name}" { failed = pkgs.testers.testBuildFailure check; } ''
      if ! grep -qF -- ${lib.escapeShellArg expected} "$failed/testBuildFailure.log"; then
        echo ${lib.escapeShellArg "${name}: the check failed without saying ${expected}:"} >&2
        cat "$failed/testBuildFailure.log" >&2
        exit 1
      fi
      touch $out
    '';

  runpod = reviewOf "runpod";
  runpodIndex = lib.importJSON (specs + "/runpod.json");
in
lib.mapAttrs' (name: profile: lib.nameValuePair "profile-${name}" (checkOf name profile)) profiles
// {
  profile-fails-on-a-group-outside-a-set =
    fails "profile-fails-on-a-group-outside-a-set"
      "pulls at api.github.com allows codespaces/create-with-pr-for-authenticated-user"
      (
        profileCheck (
          reviewOf "github"
          // {
            name = "github";
            profile = removeAttrs profiles.github [ "deny" ];
          }
        )
      );

  profile-fails-on-a-misspelt-pattern =
    fails "profile-fails-on-a-misspelt-pattern"
      "pods at api.runpod.io: POST v2/pods/*/exce matches no operation"
      (
        profileCheck (
          runpod
          // {
            name = "runpod";
            profile = lib.recursiveUpdate profiles.runpod {
              allow.pods."api.runpod.io" = map (
                rule: if rule.path == "v2/pods/*/exec" then rule // { path = "v2/pods/*/exce"; } else rule
              ) profiles.runpod.allow.pods."api.runpod.io";
            };
          }
        )
      );

  profile-fails-on-a-write-added-to-a-spec =
    fails "profile-fails-on-a-write-added-to-a-spec"
      "api.runpod.io: addPodKey (POST v2/pods/{id}/keys), in Pods, is a write nothing allows or denies"
      (
        profileCheck (
          runpod
          // {
            name = "runpod";
            profile = profiles.runpod;
            indexes = [
              (pkgs.writeText "runpod-added.json" (
                builtins.toJSON (
                  runpodIndex
                  // {
                    operations = runpodIndex.operations ++ [
                      {
                        group = "Pods";
                        host = "api.runpod.io";
                        method = "POST";
                        multiSegment = [ ];
                        operationId = "addPodKey";
                        path = "v2/pods/{id}/keys";
                      }
                    ];
                  }
                )
              ))
            ];
          }
        )
      );
}
