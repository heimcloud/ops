# Ops service options — Heimcloud incident desk.
{...}: {
  flake.modules.nixos.ops-option = {
    config,
    lib,
    pkgs,
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
                    neoBaseRef = mkOption {
                      type = types.strMatching "[A-Za-z0-9._/-]+";
                      default = "master";
                      description = ''
                        Neo branch the ops/lab host actually runs (e.g. "dev" when the host
                        pins github:madebydamo/neo/dev). Fix branches are cut from this ref
                        (fork first, then upstream) and the compare link targets it, so
                        rollback/diff never silently assume master.
                      '';
                      rank = 55;
                    };
                    hermesTimeoutSec = mkOption {
                      type = types.ints.positive;
                      default = 2700;
                      description = "Per Hermes call timeout in seconds (fix runs up to 40 turns).";
                      rank = 58;
                    };
                    extraPackages = mkOption {
                      type = types.listOf types.package;
                      # Neo CLI (cli/, crane build: pkg-config + openssl, nixpkgs rustc; no
                      # rust-toolchain file) so Hermes can cargo check/test cli changes.
                      default = with pkgs; [cargo rustc clippy rustfmt stdenv.cc pkg-config openssl openssl.dev gnumake];
                      defaultText = literalExpression "with pkgs; [cargo rustc clippy rustfmt stdenv.cc pkg-config openssl openssl.dev gnumake]";
                      # Packages are not settable from settings.toml; hide from the Neo web UI.
                      internal = true;
                      description = "Extra tools on the autofix worker/Hermes PATH (also installed for the hermes user so Hermes's terminal tool sees them).";
                    };
                    redactExtraSlugsFile = mkOption {
                      type = types.nullOr types.str;
                      default = config.neo.services.ops.redactExtraSlugsFile;
                      description = "EnvironmentFile path exporting OPS_REDACT_EXTRA_SLUGS=… (never inline secrets in nix). Defaults to neo.services.ops.redactExtraSlugsFile so one file serves docker-ops and the autofix worker.";
                      rank = 60;
                    };
                    lab = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = ''
                              Automated lab stage (needs autofix.fix.enable). After a fix branch is
                              pushed, a lab job builds this host's config with ONLY the neo input
                              overridden to the fork branch, activates it (switch-to-configuration
                              test), runs generic + Hermes-planned checks and always rolls back to the
                              previous system. Installs the root unit heimcloud-ops-labtest@, a polkit
                              rule letting hermes start exactly that unit, and enables polkit.
                            '';
                            rank = 0;
                          };
                          flake = mkOption {
                            type = types.str;
                            default = "/var/neo/DATA/AppData/configuration";
                            description = "Host config flake the lab builds (Neo server profile configPath). Never modified; flake.lock/flake.nix/settings.toml are verified byte-identical afterwards.";
                            rank = 10;
                          };
                          nixosConfiguration = mkOption {
                            type = types.strMatching "[A-Za-z0-9_-]+";
                            default = "neo";
                            description = "nixosConfigurations.<name> of that flake (Neo activates .#neo).";
                            rank = 20;
                          };
                          input = mkOption {
                            type = types.strMatching "[A-Za-z0-9_-]+";
                            default = "neo";
                            description = "Flake input overridden to the fix branch for the test only (--override-input, --no-write-lock-file).";
                            rank = 30;
                          };
                          flakeUrl = mkOption {
                            type = types.strMatching "[A-Za-z0-9:/._+?=-]*[{]branch[}][A-Za-z0-9:/._+?=&-]*";
                            default = "github:heimcloud/neo/{branch}";
                            description = "Unauthenticated URL of the public fork; {branch} is replaced by the fix branch (a branch ref, never a SHA).";
                            rank = 40;
                          };
                          opsHealth = mkOption {
                            type = types.str;
                            default = "container:ops:3000/health";
                            description = "Generic ops health check: container:<docker name>:<port><path> (address via docker inspect) or a loopback http:// URL.";
                            rank = 50;
                          };
                          hermesUnit = mkOption {
                            type = types.str;
                            default = "hermes-agent.service";
                            description = "Hermes unit that must be active after activation.";
                            rank = 55;
                          };
                          lockWaitSec = mkOption {
                            type = types.ints.unsigned;
                            default = 1800;
                            description = "Max wait for Neo's activation lock (/run/neo/locks/system.lock) before the lab job errors.";
                            rank = 60;
                          };
                          buildTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 3600;
                            description = "Build timeout (nothing is activated before the build succeeds).";
                            rank = 61;
                          };
                          activateTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 900;
                            description = "switch-to-configuration timeout for the lab system and for the rollback.";
                            rank = 62;
                          };
                          settleSec = mkOption {
                            type = types.ints.unsigned;
                            default = 30;
                            description = "Wait after activation before checks (then up to 3 min while the system is still starting).";
                            rank = 63;
                          };
                          checkTimeoutSec = mkOption {
                            type = types.ints.unsigned;
                            default = 60;
                            description = "Per-check retry window (unit active, HTTP status).";
                            rank = 64;
                          };
                          planTimeoutSec = mkOption {
                            type = types.ints.positive;
                            default = 600;
                            description = "Timeout of the Hermes call that plans the incident checks (falls back to 'incident unit active').";
                            rank = 65;
                          };
                        };
                      };
                      default = {};
                      description = "Automated lab test of pushed fix branches on this host (default off).";
                      rank = 70;
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
