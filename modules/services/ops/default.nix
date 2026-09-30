# Ops service implementation — OCI image from flake packages (import-tree).
{self, ...}: {
  flake.modules.nixos.ops = {
    config,
    lib,
    pkgs,
    ...
  }:
    with lib; let
      cfg = config.neo.services.ops;
      opsAppdata = "${config.neo.core.volumes.appdata}/ops";
      opsImage = self.packages.${pkgs.stdenv.hostPlatform.system}.heimcloud-ops;
      # The container runs as the Neo core user (homeserver) — same uid/gid every
      # other Neo container uses. Never hardcode the numbers.
      uid = toString config.neo.core.uid;
      gid = toString config.neo.core.gid;
      af = cfg.autofix;
      autofixOn = af.enable;
      triageOn = autofixOn && af.triage.enable;
      fixOn = autofixOn && af.fix.enable;
      boolStr = b:
        if b
        then "true"
        else "false";
      adminPath = let
        p = cfg.admin.path or "/admin";
      in
        if lib.hasSuffix "/" p && p != "/"
        then lib.removeSuffix "/" p
        else p;
      secretEnv = lib.filterAttrs (_: v: v != null && v != "") {
        OPS_INGEST_SECRET = cfg.ingestSecret;
        GITHUB_TOKEN = cfg.githubToken;
        OPS_GITHUB_TOKEN = cfg.githubToken;
        SITE_URL = cfg.siteUrl;
        OPS_TARGET_ALLOWLIST = cfg.targetAllowlist;
      };
      autoTriage = triageOn && af.triage.autoEnqueue;
      # Only whether a fork-push token is configured (never its value). The
      # worker's runtime check (queue/worker-status.json) overrides this hint.
      tokenConfigured = let
        cred = config.neo.services.credentials or {};
        tok = cred.ops.autofixForkPushToken or null;
      in
        (cred.enabled or false) && tok != null && tok != "";

      # Shared autofix exchange dirs (host side of the container's /data/queue and
      # /data/results). Owner = Neo core uid, group = Neo core gid, mode 2770:
      #  - the container (core uid:gid, no supplementary groups) writes jobs as owner;
      #  - the hermes worker gets rwx via membership in the core group (autofix.nix);
      #  - setgid keeps every file/subdir in the core group no matter who creates it.
      # Created unconditionally (even with autofix off) so the app never hits EACCES;
      # historically preStart made these root:root 0770 (the EACCES root cause).
      exchangeDirs = [
        "${opsAppdata}/queue"
        "${opsAppdata}/queue/triage"
        "${opsAppdata}/queue/fix"
        "${opsAppdata}/queue/push"
        "${opsAppdata}/queue/lab"
        "${opsAppdata}/queue/processing"
        "${opsAppdata}/queue/done"
        "${opsAppdata}/queue/failed"
        "${opsAppdata}/queue/control"
        "${opsAppdata}/results"
      ];
      ensureExchangeDirs = pkgs.writeShellScript "heimcloud-ops-ensure-dirs" ''
        set -eu
        ${pkgs.coreutils}/bin/install -d -m 2770 -o ${uid} -g ${gid} ${concatStringsSep " " exchangeDirs}
      '';
    in {
      config = mkIf cfg.enabled {
        # Boot/activation-time creation + ownership repair (tmpfiles "d" adjusts
        # mode/owner of existing dirs, not their contents).
        systemd.tmpfiles.rules = map (d: "d ${d} 2770 ${uid} ${gid} -") exchangeDirs;

        # Belt and braces on every container (re)start: fixes dirs left root-owned.
        systemd.services.docker-ops.preStart =
          (lib.neo.mkEnsureDirs config [opsAppdata])
          + ''
            ${ensureExchangeDirs}
          '';

        virtualisation.oci-containers.containers.ops = {
          environment =
            secretEnv
            // {
              TZ = "Europe/Zurich";
              PORT = "3000";
              NODE_ENV = "production";
              OPS_DB_PATH = "/data/ops.sqlite";
              OPS_DATA_DIR = "/data";
              OPS_AUTOTRIAGE = boolStr autoTriage;
              # Gate the admin "Start fix"/triage buttons: without a host worker a
              # queued job would never be picked up.
              OPS_AUTOFIX_FIX = boolStr fixOn;
              OPS_AUTOFIX_TRIAGE = boolStr triageOn;
              # Automated lab stage: queued/running lab tests are worker progress, not a human task.
              OPS_AUTOFIX_LAB = boolStr (fixOn && af.lab.enable);
              OPS_AUTOFIX_TOKEN_CONFIGURED = boolStr tokenConfigured;
              ADMIN_ENABLED = boolStr cfg.admin.enabled;
              ADMIN_PATH = adminPath;
              ADMIN_READ_ONLY = boolStr cfg.admin.readOnly;
            };
          # Host EnvironmentFile → container env (OPS_REDACT_EXTRA_SLUGS). Only when
          # set; Fleet must create the file (default AppData path) or docker --env-file fails.
          environmentFiles = lib.optional (cfg.redactExtraSlugsFile != null) cfg.redactExtraSlugsFile;
          image = cfg.containers.ops;
          imageFile = opsImage;
          user = "${uid}:${gid}";
          autoStart = true;
          volumes = [
            "${opsAppdata}:/data"
          ];
          networks = ["internal"];
        };
      };
    };
}
