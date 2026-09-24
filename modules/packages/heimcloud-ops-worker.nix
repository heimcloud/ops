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
    '';
    heimcloud-ops-worker = pkgs.writeShellApplication {
      name = "heimcloud-ops-worker";
      runtimeInputs = [pkgs.nodejs_22 pkgs.git pkgs.bash pkgs.coreutils];
      text = ''
        exec ${pkgs.nodejs_22}/bin/node ${workerSrc}/worker.mjs "$@"
      '';
    };
  in {
    packages = {
      inherit heimcloud-ops-worker;
    };
  };
}
