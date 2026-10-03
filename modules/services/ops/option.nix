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
                description = "GitHub token for the board's own draft PR creation (GITHUB_TOKEN). Separate from credentials ops.autofixForkPushToken, which the autofix PR loop uses and which must be a classic PAT with public_repo (one classic PAT may serve both). Prefer secrets injection.";
              };
              targetAllowlist = mkOption {
                type = types.str;
                default = "madebydamo/neo,heimcloud/*";
                description = "Deprecated and ignored: the allowlist is `targets` (one entry per upstream repo).";
              };
              targets = mkOption {
                type = types.listOf (types.submodule {
                  options = {
                    upstream = lib.mkOption {
                      type = types.strMatching "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
                      description = "owner/repo the PR goes to (the incident's target repo), e.g. madebydamo/highsea.neo.";
                    };
                    fork = lib.mkOption {
                      type = types.nullOr (types.strMatching "heimcloud/[A-Za-z0-9_.-]+");
                      default = null;
                      description = "heimcloud/<repo> the worker pushes fix/* and ops/* branches to (default heimcloud/<upstream repo>).";
                    };
                    baseRef = lib.mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      description = "Base branch / PR base (default master; the neo entry uses autofix.neoBaseRef).";
                    };
                    flakeInput = lib.mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      description = ''
                        Host flake input the lab test overrides with the fork branch. null = find
                        the one root input whose source is the upstream or the fork (a Neo plugin
                        is input plugin<N>, N = its index in core.plugins). The neo entry uses
                        autofix.lab.input.
                      '';
                    };
                    lab = lib.mkOption {
                      type = types.enum ["flake-override" "none"];
                      default = "flake-override";
                      description = "Lab method: flake-override (automated lab test) or none (needs_human, test by hand, then Skip lab).";
                    };
                    flakeUrl = lib.mkOption {
                      type = types.nullOr types.str;
                      default = null;
                      description = "Override URL with {branch} (default github:<fork>/{branch}).";
                    };
                    units = lib.mkOption {
                      type = types.listOf types.str;
                      default = [];
                      description = "Routing hint for triage: systemd unit names / globs (docker-sonarr*).";
                    };
                    paths = lib.mkOption {
                      type = types.listOf types.str;
                      default = [];
                      description = "Routing hint: repo path prefixes.";
                    };
                    keywords = lib.mkOption {
                      type = types.listOf types.str;
                      default = [];
                      description = "Routing hint: words in the logs.";
                    };
                    protectedPaths = lib.mkOption {
                      type = types.nullOr (types.listOf types.str);
                      default = null;
                      description = "Path prefixes whose lab test needs an admin approval (default none; the neo entry uses autofix.denyPaths).";
                    };
                  };
                });
                default = [];
                description = ''
                  Allowlisted upstream repos of the autofix loop (settings.toml
                  [[services.ops.targets]]). madebydamo/neo -> heimcloud/neo is always the
                  first entry (an entry for it here only adds hints / overrides). Triage
                  picks one; fix, push, lab and PR use it; unknown repos go to a human.
                '';
                rank = 9;
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
                      description = ''
                        When true (the lab host is the shared ops/lab host), fixes that touch a
                        protected path (denyPaths: ops / hermes / swag / base system) are still
                        coded and pushed, but the automated lab test waits for an admin
                        "Approve lab test" on the board (needs_human badge).
                      '';
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
                      description = "Protected path prefixes (admin approval before the lab test) while labSharesOpsHost.";
                      rank = 50;
                    };
                    basePaths = mkOption {
                      type = types.listOf types.str;
                      default = ["nix/modules/core"];
                      description = "Subset of denyPaths shown as BASE SYSTEM (stronger warning on the approval button).";
                      rank = 52;
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
                          protectedWatchdogSec = mkOption {
                            type = types.ints.between 60 3600;
                            default = 600;
                            description = ''
                              Rollback watchdog deadline for admin-approved protected lab runs (the
                              change may take down ops, Hermes or the worker). Normal runs use the
                              full run budget.
                            '';
                            rank = 66;
                          };
                        };
                      };
                      default = {};
                      description = "Automated lab test of pushed fix branches on this host (default off).";
                      rank = 70;
                    };
                    pr = mkOption {
                      type = types.submodule {
                        options = {
                          enable = mkOption {
                            type = types.bool;
                            default = false;
                            description = ''
                              Open the upstream PR automatically after a lab pass (draft + "NOT
                              lab-tested" after Skip lab), poll it, and revise the branch on review
                              feedback from the reviewer. Never merges. Uses the one GitHub token
                              (credentials ops.autofixForkPushToken) through heimcloud-autofix-pr; it
                              must be a classic PAT with public_repo. A fine-grained token cannot open
                              upstream PRs: the loop then stays disabled (compare links only).
                            '';
                            rank = 0;
                          };
                          pollMinutes = mkOption {
                            type = types.ints.between 2 5;
                            default = 3;
                            description = "Poll interval for PR state and review feedback (minutes).";
                            rank = 10;
                          };
                          reviewerLogin = mkOption {
                            type = types.str;
                            default = "madebydamo";
                            description = "The only GitHub login whose comments / reviews drive a revision (with reviewerId).";
                            rank = 20;
                          };
                          reviewerId = mkOption {
                            type = types.ints.positive;
                            default = 94169482;
                            description = "Numeric GitHub user id of reviewerLogin (login AND id must match; renames cannot spoof it).";
                            rank = 21;
                          };
                          botLogin = mkOption {
                            type = types.str;
                            default = "heimcloud";
                            description = "GitHub account the token belongs to (PR author; its own comments are ignored).";
                            rank = 22;
                          };
                          maxRounds = mkOption {
                            type = types.ints.between 1 10;
                            default = 3;
                            description = "Revision rounds per PR; after that new feedback goes to a human and nothing more is posted.";
                            rank = 30;
                          };
                          stopPhrase = mkOption {
                            type = types.str;
                            default = "/ops stop";
                            description = "A reviewer comment line equal to this stops the automation on that PR.";
                            rank = 40;
                          };
                          draft = mkOption {
                            type = types.bool;
                            default = false;
                            description = "Open lab-passed PRs as drafts too (untested ones always are).";
                            rank = 50;
                          };
                        };
                      };
                      default = {};
                      description = "Automatic upstream PR + review feedback loop (default off).";
                      rank = 75;
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
