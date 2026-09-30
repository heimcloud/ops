# Opt-in host-side autofix runner (default OFF). Does not start unless enable=true.
#
# Exchange dirs (queue/*, results) are created by the ops module for every host
# (owner = Neo core uid, group = Neo core gid, 2770 setgid). Here we only:
#  - add hermes to the Neo core group so the worker can claim jobs / write results;
#  - install the path + oneshot worker units and the two Hermes skills.
{self, ...}: {
  flake.modules.nixos.ops-autofix = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.ops;
      af = cfg.autofix;
      enabled = cfg.enabled && af.enable;
      triageOn = enabled && af.triage.enable;
      fixOn = enabled && af.fix.enable;
      workerOn = triageOn || fixOn;
      opsAppdata = "${config.neo.core.volumes.appdata}/ops";
      queueRoot = "${opsAppdata}/queue";
      workerPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.heimcloud-ops-worker;
      hermesState = config.neo.services.hermes.stateDir or "${config.neo.core.volumes.appdata}/hermes";
      hermesHome = "${hermesState}/.hermes";
      uid = toString config.neo.core.uid;
      gid = config.neo.core.gid;

      # Neo core defines users.groups.homeserver.gid = neo.core.gid (the gid the ops
      # container runs as). Literal name avoids evaluating users.groups inside
      # users.users (module-system recursion); the assertion checks the gid matches.
      coreGroup = "homeserver";

      triageSkill = ../../../skills/heimcloud-ops-triage/SKILL.md;
      fixSkill = ../../../skills/heimcloud-ops-fix/SKILL.md;

      skillStore = pkgs.runCommand "heimcloud-ops-autofix-skills" {} ''
        mkdir -p $out/heimcloud-ops-triage $out/heimcloud-ops-fix
        cp ${triageSkill} $out/heimcloud-ops-triage/SKILL.md
        cp ${fixSkill} $out/heimcloud-ops-fix/SKILL.md
      '';

      exchangeDirs = map (d: "${opsAppdata}/${d}") [
        "queue"
        "queue/triage"
        "queue/fix"
        "queue/processing"
        "queue/done"
        "queue/failed"
        "results"
      ];
      # Runs as root (ExecStartPre=+) so a root-owned leftover never blocks the worker.
      ensureDirs = pkgs.writeShellScript "heimcloud-ops-worker-ensure-dirs" ''
        set -eu
        ${pkgs.coreutils}/bin/install -d -m 2770 -o ${uid} -g ${toString gid} ${concatStringsSep " " exchangeDirs}
      '';

      hasMaterialize = config.systemd.services ? heimcloud-autofix-materialize-token;
      hermesUnitPath = config.systemd.services.hermes-agent.path or [];
    in {
      config = mkIf enabled {
        assertions = [
          {
            assertion = config.neo.services.hermes.enabled or false;
            message = "neo.services.ops.autofix.enable requires neo.services.hermes.enabled";
          }
          {
            assertion = (config.users.groups.${coreGroup}.gid or null) == gid;
            message = "neo.services.ops.autofix: users.groups.${coreGroup}.gid must equal neo.core.gid (the ops container gid) so hermes can share the exchange dirs.";
          }
        ];

        # Shared group: the container runs as core uid:gid; hermes joins that gid.
        # hermes already has passwordless sudo on Neo, so this grants nothing new.
        users.users.hermes.extraGroups = [coreGroup];

        environment.systemPackages = [workerPkg];

        # Materialize autofix skills into HERMES_HOME/skills. Store path is not under
        # *-neo-hermes-skills, so hermes-neo-skills neither prunes nor shadows it.
        system.activationScripts.heimcloud-ops-autofix-skills = lib.stringAfter ["users" "hermes-agent-setup"] ''
          # Subshell: activation snippets share one shell; do not leak set -eu.
          (
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
          )
        '';

        # Container writes /data/queue/<kind>/*.json == ${queueRoot}/<kind>/*.json on the host.
        # Only watch enabled kinds; the worker also ignores disabled kinds.
        systemd.paths.heimcloud-ops-worker = mkIf workerOn {
          description = "Watch Heimcloud Ops autofix queue";
          wantedBy = ["multi-user.target"];
          pathConfig = {
            PathExistsGlob =
              optional triageOn "${queueRoot}/triage/*.json"
              ++ optional fixOn "${queueRoot}/fix/*.json";
            Unit = "heimcloud-ops-worker.service";
          };
        };

        systemd.services.heimcloud-ops-worker = mkIf workerOn {
          description = "Heimcloud Ops autofix worker (local Hermes, concurrency 1)";
          # Re-materialize the fork-push token on every run: the credentials tmpfiles
          # rule resets /run/heimcloud-autofix to root:root 0700 at boot.
          wants = optional hasMaterialize "heimcloud-autofix-materialize-token.service";
          after = optional hasMaterialize "heimcloud-autofix-materialize-token.service";
          # hermes CLI + agent tools (same PATH as the hermes-agent gateway), git/gh/node
          # for the worker, and the system profile for heimcloud-autofix-env and
          # heimcloud-lab-test (Fleet-owned, when installed).
          path =
            [workerPkg pkgs.nodejs_22 pkgs.git pkgs.gh pkgs.openssh pkgs.sqlite pkgs.bash pkgs.coreutils pkgs.util-linux]
            ++ hermesUnitPath
            ++ ["/run/current-system/sw" "/etc/profiles/per-user/hermes"];
          unitConfig = {
            ConditionPathExists = [opsAppdata];
          };
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            # Results must be group-readable by the container (core gid via setgid dirs).
            UMask = "0007";
            RuntimeDirectory = "heimcloud-ops-worker";
            RuntimeDirectoryMode = "0700";
            WorkingDirectory = "${hermesState}/workspace";
            TimeoutStartSec = "${toString (af.hermesTimeoutSec * (af.maxAttempts + 1) + 900)}";
            ExecStartPre = ["+${ensureDirs}"];
            ExecStart = "${workerPkg}/bin/heimcloud-ops-worker --once";
            Environment =
              [
                "OPS_DATA_DIR=${opsAppdata}"
                "OPS_AUTOFIX_LOCK=/run/heimcloud-ops-worker/lock"
                "OPS_AUTOFIX_MAX_ATTEMPTS=${toString af.maxAttempts}"
                "OPS_AUTOFIX_LAB_SHARES_OPS_HOST=${
                  if af.labSharesOpsHost
                  then "true"
                  else "false"
                }"
                "OPS_AUTOFIX_DENY_PATHS=${concatStringsSep "," af.denyPaths}"
                "OPS_NEO_BASE_REF=${af.neoBaseRef}"
                "OPS_AUTOFIX_HERMES_TIMEOUT_SEC=${toString af.hermesTimeoutSec}"
                "OPS_DB_PATH=${opsAppdata}/ops.sqlite"
                "HOME=${hermesState}"
                "HERMES_HOME=${hermesHome}"
                "HERMES_MANAGED=true"
              ]
              ++ optional triageOn "OPS_AUTOFIX_TRIAGE=1"
              ++ optional fixOn "OPS_AUTOFIX_FIX=1";
            # Required (fail-closed): without extra slugs the redaction gate is weaker.
            EnvironmentFile = mkIf (af.redactExtraSlugsFile != null) [af.redactExtraSlugsFile];
          };
        };
      };
    };
}
