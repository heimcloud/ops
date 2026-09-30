# Opt-in host-side autofix runner (default OFF). Does not start unless enable=true.
#
# Exchange dirs (queue/*, results) are created by the ops module for every host
# (owner = Neo core uid, group = Neo core gid, 2770 setgid). Here we only:
#  - add hermes to the Neo core group so the worker can claim jobs / write results;
#  - install the path + oneshot worker units and the two Hermes skills;
#  - install the root kick timer (self-lockout watchdog, see below);
#  - with autofix.lab.enable: the root lab runner heimcloud-ops-labtest@ and a
#    polkit rule that lets hermes start exactly that unit (see below).
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
      lab = af.lab;
      labOn = fixOn && lab.enable;
      # Upper bound of one lab run (lock wait + build + activation + settle +
      # generic/incident checks + rollback), used for unit timeouts / worker wait.
      labRunSec = lab.lockWaitSec + lab.buildTimeoutSec + lab.activateTimeoutSec + lab.settleSec + 180 + 20 * lab.checkTimeoutSec + lab.activateTimeoutSec + 300;
      labUnitRe = "^heimcloud-ops-labtest@lab-[0-9]{1,9}-[A-Za-z0-9-]{1,80}\\.service$";
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
      labSkill = ../../../skills/heimcloud-ops-labtest/SKILL.md;

      skillStore = pkgs.runCommand "heimcloud-ops-autofix-skills" {} ''
        mkdir -p $out/heimcloud-ops-triage $out/heimcloud-ops-fix $out/heimcloud-ops-labtest
        cp ${triageSkill} $out/heimcloud-ops-triage/SKILL.md
        cp ${fixSkill} $out/heimcloud-ops-fix/SKILL.md
        cp ${labSkill} $out/heimcloud-ops-labtest/SKILL.md
      '';

      exchangeDirs = map (d: "${opsAppdata}/${d}") [
        "queue"
        "queue/triage"
        "queue/fix"
        "queue/push"
        "queue/lab"
        "queue/processing"
        "queue/done"
        "queue/failed"
        "queue/control"
        "results"
      ];
      # Runs as root (ExecStartPre=+) so a root-owned leftover never blocks the worker.
      ensureDirs = pkgs.writeShellScript "heimcloud-ops-worker-ensure-dirs" ''
        set -eu
        ${pkgs.coreutils}/bin/install -d -m 2770 -o ${uid} -g ${toString gid} ${concatStringsSep " " exchangeDirs}
      '';

      workerEnv =
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
          "OPS_AUTOFIX_BASE_PATHS=${concatStringsSep "," af.basePaths}"
          "OPS_NEO_BASE_REF=${af.neoBaseRef}"
          "OPS_AUTOFIX_HERMES_TIMEOUT_SEC=${toString af.hermesTimeoutSec}"
          "OPS_DB_PATH=${opsAppdata}/ops.sqlite"
          "HOME=${hermesState}"
          "HERMES_HOME=${hermesHome}"
          "HERMES_MANAGED=true"
          # Rust builds for neo cli changes: shared target dir outside the clone
          # (never committed), openssl-sys via pkg-config/explicit dirs.
          "CARGO_TARGET_DIR=${hermesState}/.cache/heimcloud-ops-cargo-target"
          "PKG_CONFIG_PATH=${pkgs.openssl.dev}/lib/pkgconfig"
          "OPENSSL_LIB_DIR=${getLib pkgs.openssl}/lib"
          "OPENSSL_INCLUDE_DIR=${pkgs.openssl.dev}/include"
        ]
        ++ optional triageOn "OPS_AUTOFIX_TRIAGE=1"
        ++ optional fixOn "OPS_AUTOFIX_FIX=1"
        ++ optionals labOn [
          "OPS_AUTOFIX_LAB=1"
          "OPS_AUTOFIX_LAB_STATE_DIR=/var/lib/heimcloud-ops-labtest"
          "OPS_AUTOFIX_LAB_WAIT_SEC=${toString (labRunSec + 600)}"
          "OPS_AUTOFIX_LAB_PLAN_TIMEOUT_SEC=${toString lab.planTimeoutSec}"
          "OPS_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
        ];

      workerPath =
        [workerPkg pkgs.nodejs_22 pkgs.git pkgs.gh pkgs.openssh pkgs.sqlite pkgs.bash pkgs.coreutils pkgs.util-linux]
        ++ af.extraPackages
        ++ hermesUnitPath
        ++ ["/run/current-system/sw" "/etc/profiles/per-user/hermes"];

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
            assertion = !lab.enable || af.fix.enable;
            message = "neo.services.ops.autofix.lab.enable requires autofix.fix.enable (lab jobs follow pushed fixes).";
          }
          {
            assertion = (config.users.groups.${coreGroup}.gid or null) == gid;
            message = "neo.services.ops.autofix: users.groups.${coreGroup}.gid must equal neo.core.gid (the ops container gid) so hermes can share the exchange dirs.";
          }
        ];

        # Shared group: the container runs as core uid:gid; hermes joins that gid.
        # hermes already has passwordless sudo on Neo, so this grants nothing new.
        users.users.hermes.extraGroups = [coreGroup];
        # Hermes's terminal tool rebuilds PATH from the NixOS profiles, so the
        # toolchain must be in the hermes user profile too (not only the unit PATH).
        users.users.hermes.packages = af.extraPackages;

        environment.systemPackages = [workerPkg];

        # Materialize autofix skills into HERMES_HOME/skills. Store path is not under
        # *-neo-hermes-skills, so hermes-neo-skills neither prunes nor shadows it.
        system.activationScripts.heimcloud-ops-autofix-skills = lib.stringAfter ["users" "hermes-agent-setup"] ''
          # Subshell: activation snippets share one shell; do not leak set -eu.
          (
            set -euo pipefail
            skills_dir="${hermesHome}/skills"
            mkdir -p "$skills_dir"
            for name in heimcloud-ops-triage heimcloud-ops-fix heimcloud-ops-labtest; do
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
        # PathChanged (edge: a job file appears) instead of PathExistsGlob (level):
        # with the queue paused, or a job the worker leaves pending, a level trigger
        # re-fires as soon as the oneshot exits and hits the start limit, which
        # fails the path unit too (self-lockout). The worker drains until empty;
        # heimcloud-ops-worker-kick.timer covers anything enqueued while it exits.
        systemd.paths.heimcloud-ops-worker = mkIf workerOn {
          description = "Watch Heimcloud Ops autofix queue";
          wantedBy = ["multi-user.target"];
          pathConfig = {
            PathChanged =
              optional triageOn "${queueRoot}/triage"
              ++ optionals fixOn ["${queueRoot}/fix" "${queueRoot}/push"]
              ++ optional labOn "${queueRoot}/lab";
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
          path = workerPath;
          # A switch (Neo activation, or the lab test's own activation of a fix
          # branch that changes the Hermes PATH) must not kill a running job; the
          # next start picks up the new unit.
          restartIfChanged = false;
          stopIfChanged = false;
          unitConfig = {
            ConditionPathExists = [opsAppdata];
            # Default is 5 starts / 10 s: a burst of Start triage clicks against an
            # idle worker could trip it. The worker exits 0 on per-job errors, so
            # the unit only fails on real breakage; the kick timer resets it.
            StartLimitIntervalSec = 120;
            StartLimitBurst = 30;
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
            TimeoutStartSec = "${toString (af.hermesTimeoutSec * (af.maxAttempts + 1) + 900 + (
              if labOn
              then labRunSec + 600 + lab.planTimeoutSec
              else 0
            ))}";
            ExecStartPre = ["+${ensureDirs}"];
            ExecStart = "${workerPkg}/bin/heimcloud-ops-worker --once";
            Environment = workerEnv;
            # Required (fail-closed): without extra slugs the redaction gate is weaker.
            EnvironmentFile = mkIf (af.redactExtraSlugsFile != null) [af.redactExtraSlugsFile];
          };
        };

        # Self-lockout watchdog (root, every 2 min): reset-failed on a failed /
        # start-limited worker path or service while jobs are pending, restart the
        # path watch if it is down, start the worker when jobs wait and the queue is
        # not paused, and report unit health to queue/systemd-status.json for the
        # admin worker panel. Only systemctl + that one file; no job handling.
        systemd.services.heimcloud-ops-worker-kick = mkIf workerOn {
          description = "Heimcloud Ops autofix worker watchdog";
          path = [workerPkg pkgs.nodejs_22 config.systemd.package];
          unitConfig.ConditionPathExists = [opsAppdata];
          serviceConfig = {
            Type = "oneshot";
            UMask = "0027";
            NoNewPrivileges = true;
            PrivateTmp = true;
            ExecStart = "${workerPkg}/bin/heimcloud-ops-worker --kick";
            Environment =
              [
                "OPS_DATA_DIR=${opsAppdata}"
                "OPS_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
              ]
              ++ optional triageOn "OPS_AUTOFIX_TRIAGE=1"
              ++ optional fixOn "OPS_AUTOFIX_FIX=1"
              ++ optional labOn "OPS_AUTOFIX_LAB=1";
          };
        };
        systemd.timers.heimcloud-ops-worker-kick = mkIf workerOn {
          description = "Heimcloud Ops autofix worker watchdog";
          wantedBy = ["timers.target"];
          timerConfig = {
            OnBootSec = "2min";
            OnUnitActiveSec = "2min";
            AccuracySec = "15s";
          };
        };

        # ---------------------------------------------------------------- lab
        # Root boundary of the automated lab stage. The worker (hermes) may only
        #   systemctl start heimcloud-ops-labtest@lab-<incident>-<stamp>.service
        # (polkit rule below: verb "start", that unit pattern, user hermes). The
        # runner re-validates the job spec it reads from queue/processing (branch
        # regex, whitelisted checks, no shell), takes a lab lock + Neo's activation
        # lock, builds the host flake with ONLY the neo input overridden to the
        # public fork branch, arms a transient root timer that rolls back on its
        # own, activates with switch-to-configuration test (no boot entry, no
        # profile generation), checks, ALWAYS switches back to the recorded
        # previous system, verifies it + byte-identical pins, then disarms.
        systemd.services."heimcloud-ops-labtest@" = mkIf labOn {
          description = "Heimcloud Ops automated lab test %i (activates a fix branch, always rolls back)";
          # Never restarted/stopped by a switch: it is the thing switching.
          restartIfChanged = false;
          stopIfChanged = false;
          path = [config.nix.package pkgs.git pkgs.util-linux pkgs.coreutils pkgs.bash pkgs.sqlite config.systemd.package config.virtualisation.docker.package];
          unitConfig.ConditionPathExists = [opsAppdata];
          # Independent of ops / Hermes / the worker on purpose: no Requires /
          # BindsTo / PartOf / After on them, so a protected change that kills
          # any of them cannot stop the runner (or its watchdog) mid-rollback.
          serviceConfig = {
            Type = "oneshot";
            User = "root";
            # Results/status readable by the worker (hermes), nobody else.
            Group = "hermes";
            UMask = "0027";
            StateDirectory = "heimcloud-ops-labtest";
            StateDirectoryMode = "0750";
            ExecStart = "${workerPkg}/bin/heimcloud-ops-labtest --run %i";
            # SIGTERM only to the runner: it skips remaining checks and rolls back.
            KillMode = "mixed";
            TimeoutStartSec = "${toString labRunSec}";
            TimeoutStopSec = "${toString (lab.activateTimeoutSec + 120)}";
            Environment = [
              "LABTEST_OPS_DIR=${opsAppdata}"
              "LABTEST_STATE_DIR=/var/lib/heimcloud-ops-labtest"
              "LABTEST_FLAKE=${lab.flake}"
              "LABTEST_NIXOS_CONFIG=${lab.nixosConfiguration}"
              "LABTEST_INPUT=${lab.input}"
              "LABTEST_FLAKE_URL=${lab.flakeUrl}"
              "LABTEST_LOCK_WAIT_SEC=${toString lab.lockWaitSec}"
              "LABTEST_BUILD_TIMEOUT_SEC=${toString lab.buildTimeoutSec}"
              "LABTEST_ACTIVATE_TIMEOUT_SEC=${toString lab.activateTimeoutSec}"
              "LABTEST_ROLLBACK_TIMEOUT_SEC=${toString lab.activateTimeoutSec}"
              "LABTEST_SETTLE_SEC=${toString lab.settleSec}"
              "LABTEST_CHECK_TIMEOUT_SEC=${toString lab.checkTimeoutSec}"
              "LABTEST_OPS_HEALTH=${lab.opsHealth}"
              "LABTEST_HERMES_UNIT=${lab.hermesUnit}"
              "LABTEST_SYSTEMCTL_BIN=${config.systemd.package}/bin/systemctl"
              "LABTEST_SYSTEMD_RUN_BIN=${config.systemd.package}/bin/systemd-run"
              "LABTEST_JOURNALCTL_BIN=${config.systemd.package}/bin/journalctl"
              "LABTEST_FLOCK_BIN=${pkgs.util-linux}/bin/flock"
              "LABTEST_DOCKER_BIN=${config.virtualisation.docker.package}/bin/docker"
              "LABTEST_NIX_BIN=${config.nix.package}/bin/nix"
              # Protected paths (admin-approved runs only): the runner detects them
              # itself (deployed neo source vs the fork branch), verifies the app's
              # HMAC approval (key under ${opsAppdata}/private, owned by the ops uid)
              # + the lab_approved DB event, and uses the short watchdog.
              "LABTEST_SHARES_OPS_HOST=${
                if af.labSharesOpsHost
                then "true"
                else "false"
              }"
              "LABTEST_PROTECTED_PATHS=${concatStringsSep "," af.denyPaths}"
              "LABTEST_BASE_PATHS=${concatStringsSep "," af.basePaths}"
              "LABTEST_PROTECTED_WATCHDOG_SEC=${toString lab.protectedWatchdogSec}"
              "LABTEST_OPS_UID=${uid}"
              "LABTEST_OPS_UNIT=${config.virtualisation.oci-containers.backend}-ops.service"
              "LABTEST_DB_PATH=${opsAppdata}/ops.sqlite"
              "LABTEST_SQLITE_BIN=${pkgs.sqlite}/bin/sqlite3"
            ];
            # Evidence redaction uses the same extra slugs as the worker.
            EnvironmentFile = mkIf (af.redactExtraSlugsFile != null) [af.redactExtraSlugsFile];
          };
        };

        security.polkit.enable = mkIf labOn true;
        security.polkit.extraConfig = mkIf labOn ''
          // heimcloud-ops autofix: the worker (user hermes) may START exactly
          // heimcloud-ops-labtest@lab-<incident>-<stamp>.service. Nothing else:
          // no stop/restart, no other unit, no other user.
          polkit.addRule(function(action, subject) {
            if (action.id == "org.freedesktop.systemd1.manage-units" &&
                subject.user == "hermes" &&
                action.lookup("verb") == "start" &&
                /${labUnitRe}/.test(action.lookup("unit") || "")) {
              return polkit.Result.YES;
            }
          });
        '';

        # Push a saved fix (ready_no_token / push_failed, or a legacy scratch clone
        # without push-pending.json) without a second Hermes run:
        #   systemctl start heimcloud-ops-worker-push@<job>.service
        # <job> = scratch dir name under ${hermesState}/workspace/autofix (fix-<id>-<ts>),
        # also shown as "job" in the incident event. Admin "Retry push" = queue/push.
        systemd.services."heimcloud-ops-worker-push@" = mkIf fixOn {
          description = "Heimcloud Ops autofix: push saved fix %i";
          wants = optional hasMaterialize "heimcloud-autofix-materialize-token.service";
          after = optional hasMaterialize "heimcloud-autofix-materialize-token.service";
          path = workerPath;
          serviceConfig = {
            Type = "oneshot";
            User = "hermes";
            Group = "hermes";
            UMask = "0007";
            RuntimeDirectory = "heimcloud-ops-worker-push-%i";
            RuntimeDirectoryMode = "0700";
            WorkingDirectory = "${hermesState}/workspace";
            TimeoutStartSec = "3600";
            ExecStartPre = ["+${ensureDirs}"];
            ExecStart = "${workerPkg}/bin/heimcloud-ops-worker --push-pending ${hermesState}/workspace/autofix/%i";
            Environment = workerEnv ++ ["OPS_AUTOFIX_LOCK=/run/heimcloud-ops-worker-push-%i/lock"];
            EnvironmentFile = mkIf (af.redactExtraSlugsFile != null) [af.redactExtraSlugsFile];
          };
        };
      };
    };
}
