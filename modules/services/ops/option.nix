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
              redactExtraSlugsFile = mkOption {
                type = types.nullOr types.str;
                default = "/var/neo/DATA/AppData/ops/redact-extra.env";
                description = ''
                  Host path to an EnvironmentFile exporting OPS_REDACT_EXTRA_SLUGS=…
                  (never inline secrets in nix). Passed to the docker-ops container via
                  oci-containers environmentFiles regardless of autofix. Default is
                  persistent AppData; Fleet must create the file (0600) or the
                  container runtime may fail on a missing --env-file.
                '';
                rank = 15;
              };
              autofix = mkOption {
                type = types.submodule {
                  options = {
                    enable = mkOption {
                      type = types.bool;
                      default = false;
                      description = "Master switch for host-side autofix runner (default OFF). When false, no path/worker units are installed.";
                      rank = 0;
                    };
                    triage = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Process triage jobs from queue/triage via local Hermes.";
                            rank = 0;
                          };
                          autoEnqueue = mkOption {
                            type = types.bool;
                            default = false;
                            description = "When true, ops container sets OPS_AUTOTRIAGE=1 to enqueue triage on new incidents.";
                            rank = 10;
                          };
                        };
                      };
                      default = {};
                      description = "Triage worker controls.";
                      rank = 10;
                    };
                    fix = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Process fix jobs (Hermes + heimcloud-autofix-env push).";
                            rank = 0;
                          };
                        };
                      };
                      default = {};
                      description = "Fix worker controls.";
                      rank = 20;
                    };
                    maxAttempts = mkOption {
                      type = types.ints.positive;
                      default = 2;
                      description = "Max Hermes fix retries after failed lab test.";
                      rank = 30;
                    };
                    labSharesOpsHost = mkOption {
                      type = types.bool;
                      default = true;
                      description = "When true (hattori today), deny-list patches that touch ops/hermes/swag/core.";
                      rank = 40;
                    };
                    denyPaths = mkOption {
                      type = types.listOf types.str;
                      default = [
                        "nix/services/ops"
                        "nix/services/hermes"
                        "nix/services/swag"
                        "nix/modules/core"
                      ];
                      description = "Path prefixes refused in fix diffs while labSharesOpsHost.";
                      rank = 50;
                    };
                    redactExtraSlugsFile = mkOption {
                      type = types.nullOr types.str;
                      default = config.neo.services.ops.redactExtraSlugsFile;
                      description = "EnvironmentFile path exporting OPS_REDACT_EXTRA_SLUGS=… (never inline secrets in nix). Defaults to neo.services.ops.redactExtraSlugsFile so one file serves docker-ops and the autofix worker.";
                      rank = 60;
                    };
                  };
                };
                default = {};
                description = "Opt-in autofix loop (local Hermes + fork push). Default entirely off.";
                rank = 20;
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
                Tinyauth-gated admin; opt-in autofix runner (default off); no auto-merge.
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
