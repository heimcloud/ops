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
      cp ${../../app/lib/lab-checks.js} $out/lab-checks.js
      cp ${../../scripts/autofix/labtest.mjs} $out/labtest.mjs
      cp ${../../app/lib/targets.js} $out/targets.js
      cp ${../../scripts/autofix/pr.mjs} $out/pr.mjs
      cp ${../../scripts/autofix/pr-wrapper.mjs} $out/pr-wrapper.mjs
      cp ${../../scripts/autofix/push-guard.mjs} $out/push-guard.mjs
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
    # The only code that hands the GitHub token to the REST API (whitelisted
    # PR / comment / read calls on allowlisted upstreams; --check verifies it).
    prWrapper = pkgs.writeShellApplication {
      name = "heimcloud-autofix-pr";
      runtimeInputs = [pkgs.nodejs_22];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/pr-wrapper.mjs "$@"
      '';
    };
    heimcloud-ops-worker = pkgs.symlinkJoin {
      name = "heimcloud-ops-worker";
      paths = [worker labtest prWrapper];
    };
  in {
    packages = {
      inherit heimcloud-ops-worker;
    };
  };
}
