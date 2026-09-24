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
      autoTriage =
        (cfg.autofix.enable or false)
        && (cfg.autofix.triage.autoEnqueue or false);
    in {
      config = mkIf cfg.enabled {
        systemd.services.docker-ops.preStart =
          (lib.neo.mkEnsureDirs config [opsAppdata])
          + ''
            mkdir -p ${opsAppdata}/queue/triage ${opsAppdata}/queue/fix ${opsAppdata}/results
            # Container uid must write jobs; hermes group reads when autofix enabled.
            chmod 0770 ${opsAppdata}/queue ${opsAppdata}/queue/triage ${opsAppdata}/queue/fix ${opsAppdata}/results || true
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
              OPS_AUTOTRIAGE =
                if autoTriage
                then "true"
                else "false";
              ADMIN_ENABLED =
                if cfg.admin.enabled
                then "true"
                else "false";
              ADMIN_PATH = adminPath;
              ADMIN_READ_ONLY =
                if cfg.admin.readOnly
                then "true"
                else "false";
            };
          # Host EnvironmentFile → container env (OPS_REDACT_EXTRA_SLUGS). Only when
          # set; Fleet must create the file (default AppData path) or docker --env-file fails.
          environmentFiles = lib.optional (cfg.redactExtraSlugsFile != null) cfg.redactExtraSlugsFile;
          image = cfg.containers.ops;
          imageFile = opsImage;
          user = "${toString config.neo.core.uid}:${toString config.neo.core.gid}";
          autoStart = true;
          volumes = [
            "${opsAppdata}:/data"
          ];
          networks = ["internal"];
        };
      };
    };
}
