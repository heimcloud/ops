# Effective autofix target list (rendered to OPS_TARGETS / LABTEST_TARGETS).
# madebydamo/neo -> heimcloud/neo is always first; a user entry for it only
# adds routing hints / overrides. Outside modules/ on purpose (modules/ is
# import-tree'd).
{
  lib,
  cfg,
}: let
  af = cfg.autofix;
  isNeo = t: lib.toLower t.upstream == "madebydamo/neo";
  user = cfg.targets or [];
  neoUser = lib.findFirst isNeo null user;
  clean = t: lib.filterAttrs (_: v: v != null) t;
  neo =
    {
      upstream = "madebydamo/neo";
      fork = "heimcloud/neo";
      baseRef = af.neoBaseRef;
      flakeInput = af.lab.input;
      lab = "flake-override";
      flakeUrl = af.lab.flakeUrl;
      units = [];
      paths = [];
      keywords = [];
      protectedPaths = af.denyPaths;
    }
    // lib.optionalAttrs (neoUser != null) (clean (removeAttrs neoUser ["upstream" "_module"]));
  others = map (t: clean (removeAttrs t ["_module"])) (lib.filter (t: !isNeo t) user);
in
  [neo] ++ others
