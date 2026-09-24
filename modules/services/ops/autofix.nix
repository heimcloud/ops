# Opt-in host-side autofix runner (default OFF). Does not start unless enable=true.
{self, ...}: {
  flake.modules.nixos.ops-autofix = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.ops;
      af = cfg.autofix or {};
      enabled = (cfg.enabled or false) && (af.enable or false);
      opsAppdata = "${config.neo.core.volumes.appdata}/ops";
      queueRoot = "${opsAppdata}/queue";
      resultsRoot = "${opsAppdata}/results";
      workerPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.heimcloud-ops-worker;
      hermesHome = "${config.neo.services.hermes.stateDir or "/var/neo/DATA/AppData/hermes"}/.hermes";
      uid = config.neo.core.uid;
      gid = config.neo.core.gid;

      triageSkill = ../../../skills/heimcloud-ops-triage/SKILL.md;
      fixSkill = ../../../skills/heimcloud-ops-fix/SKILL.md;

      skillStore = pkgs.runCommand "heimcloud-ops-autofix-skills" {} ''
        mkdir -p $out/heimcloud-ops-triage $out/heimcloud-ops-fix
        cp ${triageSkill} $out/heimcloud-ops-triage/SKILL.md
        cp ${fixSkill} $out/heimcloud-ops-fix/SKILL.md
      '';
    in {
      config = mkIf enabled {
        assertions = [
          {
            assertion = config.neo.services.hermes.enabled or false;
            message = "neo.services.ops.autofix.enable requires neo.services.hermes.enabled";
          }
        ];

        # Shared dirs: container (neo uid/gid) writes jobs; hermes reads jobs / writes results.
        systemd.tmpfiles.rules = [
          "d ${opsAppdata} 0770 ${toString uid} ${toString gid} -"
          "d ${queueRoot} 0770 ${toString uid} hermes -"
          "d ${queueRoot}/triage 0770 ${toString uid} hermes -"
          "d ${queueRoot}/fix 0770 ${toString uid} hermes -"
          "d ${resultsRoot} 0770 hermes ${toString gid} -"
        ];

        environment.systemPackages = [workerPkg];

        # Materialize autofix skills into HERMES_HOME/skills (same pattern as credentials ingest skill).
        system.activationScripts.heimcloud-ops-autofix-skills = lib.stringAfter ["users" "hermes-agent-setup"] ''
          set -euo pipefail
          skills_dir="${hermesHome}/skills"
          mkdir -p "$skills_dir"
          for name in heimcloud-ops-triage heimcloud-ops-fix; do
            dest="$skills_dir/$name"
            src="${skillStore}/$name"
            if [ -L "$dest" ] || [ -e "$dest" ]; then rm -rf "$dest"; fi
            ln -sfn "$src" "$dest"
            chown -h hermes:hermes "$dest" 2>/dev/null || true
          done
          chown hermes:hermes "$skills_dir" 2>/dev/null || true
        '';

        systemd.paths.heimcloud-ops-worker = mkIf ((af.triage.enable or false) || (af.fix.enable or false)) {
          description = "Watch Heimcloud Ops autofix queue";
          wantedBy = ["multi-user.target"];
          pathConfig = {
            PathExistsGlob = [
              "${queueRoot}/triage/*.json"
              "${queueRoot}/fix/*.json"
            ];
            Unit = "heimcloud-ops-worker.service";
          };
        };

        systemd.services.heimcloud-ops-worker = mkIf ((af.triage.enable or false) || (af.fix.enable or false)) {
          description = "Heimcloud Ops autofix worker (local Hermes, concurrency 1)";
          path = [workerPkg pkgs.git pkgs.bash pkgs.coreutils pkgs.util-linux];
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            WorkingDirectory = "${config.neo.services.hermes.stateDir or "/var/neo/DATA/AppData/hermes"}/workspace";
            # EnvironmentFile is optional — only when operator sets a path.
            Environment =
              [
                "OPS_DATA_DIR=${opsAppdata}"
                "OPS_AUTOFIX_MAX_ATTEMPTS=${toString (af.maxAttempts or 2)}"
                "OPS_AUTOFIX_LAB_SHARES_OPS_HOST=${
                  if af.labSharesOpsHost or true
                  then "true"
                  else "false"
                }"
                "OPS_AUTOFIX_DENY_PATHS=${concatStringsSep "," (af.denyPaths or ["nix/services/ops" "nix/services/hermes" "nix/services/swag" "nix/modules/core"])}"
                "HOME=${config.neo.services.hermes.stateDir or "/var/neo/DATA/AppData/hermes"}"
                "HERMES_HOME=${hermesHome}"
              ]
              ++ optional (af.triage.enable or false) "OPS_AUTOFIX_TRIAGE=1"
              ++ optional (af.fix.enable or false) "OPS_AUTOFIX_FIX=1";
            EnvironmentFile = mkIf (af.redactExtraSlugsFile != null) [af.redactExtraSlugsFile];
            ConditionPathExists = ["${opsAppdata}"];
          };
          script = ''
            set -euo pipefail
            exec ${workerPkg}/bin/heimcloud-ops-worker --once
          '';
        };
      };
    };
}
