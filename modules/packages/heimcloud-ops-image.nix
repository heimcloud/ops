# Expose heimcloud-ops OCI image as flake package: nix build .#heimcloud-ops
{...}: {
  perSystem = {pkgs, ...}: let
    heimcloud-ops = pkgs.callPackage ../../package.nix {};
  in {
    packages = {
      inherit heimcloud-ops;
      default = heimcloud-ops;
    };
  };
}
