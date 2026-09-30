# Host-side autofix worker (Node). Opt-in via neo.services.ops.autofix.
{
  lib,
  self,
  ...
}: {
  perSystem = {pkgs, ...}: let
    workerSrc = pkgs.runCommand "heimcloud-ops-worker-src" {} ''
      mkdir -p $out
      cp ${../../scripts/autofix/worker.mjs} $out/worker.mjs
      cp ${../../scripts/autofix/redact.js} $out/redact.js
      cp ${../../scripts/autofix/compare.js} $out/compare.js
      cp ${../../scripts/autofix/queue-control.js} $out/queue-control.js
      cp ${../../scripts/autofix/lab-checks.js} $out/lab-checks.js
      cp ${../../scripts/autofix/labtest.mjs} $out/labtest.mjs
    '';
    worker = pkgs.writeShellApplication {
      name = "heimcloud-ops-worker";
      runtimeInputs = [pkgs.nodejs_22 pkgs.git pkgs.bash pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/worker.mjs "$@"
      '';
    };
    # Root lab runner (heimcloud-ops-labtest@<job>.service only). node + the
    # script are store paths, so its rollback watchdog does not depend on the
    # system being tested.
    labtest = pkgs.writeShellApplication {
      name = "heimcloud-ops-labtest";
      runtimeInputs = [pkgs.nodejs_22 pkgs.util-linux pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/labtest.mjs "$@"
      '';
    };
    heimcloud-ops-worker = pkgs.symlinkJoin {
      name = "heimcloud-ops-worker";
      paths = [worker labtest];
    };
  in {
    packages = {
      inherit heimcloud-ops-worker;
    };
  };
}
