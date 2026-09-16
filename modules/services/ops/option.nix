# Ops service options — Heimcloud incident desk.
{...}: {
  flake.modules.nixos.ops-option = {
    config,
    lib,
    ...
  }:
    with lib;
    with {inherit (lib.neo) mkOption mkEnableOption;}; {
      options.neo.services.ops = mkOption {
        type = types.submodule {
          options =
            {
              enabled = mkEnableOption "Heimcloud Ops incident desk" {rank = 0;};
              ingestSecret = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Shared secret for POST /api/incidents (OPS_INGEST_SECRET). Bearer or X-Ops-Secret.";
              };
              githubToken = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "GitHub token for draft PR creation (GITHUB_TOKEN). Prefer secrets injection.";
              };
              targetAllowlist = mkOption {
                type = types.str;
                default = "madebydamo/neo,heimcloud/*";
                description = "Comma-separated Create-PR allowlist (exact owner/repo or owner/*).";
              };
              siteUrl = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Public site URL (e.g. https://ops.heimcloud.site).";
              };
              admin = mkOption {
                type = types.submodule {
                  options = {
                    enabled = mkOption {
                      type = types.bool;
                      default = true;
                      description = "Enable in-app admin UI (ADMIN_ENABLED).";
                      rank = 0;
                    };
                    path = mkOption {
                      type = types.str;
                      default = "/admin";
                      description = "Admin URL path with no trailing slash (ADMIN_PATH).";
                      rank = 10;
                    };
                    auth = mkOption {
                      type = types.bool;
                      default = true;
                      description = "When true (and Tinyauth is enabled), SWAG Tinyauth-protects admin locations.";
                      rank = 20;
                    };
                    readOnly = mkOption {
                      type = types.bool;
                      default = false;
                      description = "Disable mutating admin forms (ADMIN_READ_ONLY).";
                      rank = 30;
                    };
                  };
                };
                default = {};
                description = "Admin UI for incidents. Gated by Tinyauth at the Neo reverse-proxy edge when admin.auth is true; ingest stays shared-secret only.";
                rank = 10;
              };
            }
            // lib.neo.mkReverseProxyOptions {
              subdomain = "ops";
              auth.enabled = false;
            }
            // lib.neo.mkVpnOptions {
              containers = ["ops"];
              networks = ["internal"];
              ports = [3000];
            }
            // lib.neo.mkContainerDefinitions {
              ops = "heimcloud-ops:latest";
            }
            // lib.neo.mkAppdata "${config.neo.core.volumes.appdata}/ops"
            // lib.neo.mkServiceMeta {
              category = "Ops/Incidents";
              description = ''
                Heimcloud Ops phase 1 — secret-gated incident ingest, SQLite WAL,
                Tinyauth-gated admin with draft PR shell (no auto-merge).
                Deploy later on hattori / ops.heimcloud.site via Fleet.
              '';
              projectUrl = "https://github.com/heimcloud/ops";
              githubUrl = "https://github.com/heimcloud/ops";
            };
        };
        default = {};
        description = "Heimcloud Ops service configuration";
      };
    };
}
