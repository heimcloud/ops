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
    in {
      config = mkIf cfg.enabled {
        systemd.services.docker-ops.preStart = lib.neo.mkEnsureDirs config [opsAppdata];

        virtualisation.oci-containers.containers.ops = {
          environment =
            secretEnv
            // {
              TZ = "Europe/Zurich";
              PORT = "3000";
              NODE_ENV = "production";
              OPS_DB_PATH = "/data/ops.sqlite";
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
