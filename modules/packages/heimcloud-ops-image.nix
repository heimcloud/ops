# packages.heimcloud-ops — OCI image (buildNpmPackage + dockerTools).
# NixOS module consumes self.packages.<system>.heimcloud-ops as imageFile.
{
  lib,
  self,
  ...
}: {
  perSystem = {pkgs, ...}: let
    inherit (pkgs) dockerTools buildNpmPackage nodejs_22 python3 pkg-config sqlite cacert tzdata fakeNss srcOnly removeReferencesTo;
    nodejs = nodejs_22;
    nodeSources = srcOnly nodejs;

    app = buildNpmPackage {
      pname = "heimcloud-ops";
      version = "0.1.0";
      src = lib.cleanSourceWith {
        src = self + "/app";
        filter = path: type: let
          base = baseNameOf path;
        in
          base
          != "node_modules"
          && base != ".env"
          && base != "data"
          && !(lib.hasSuffix ".sqlite" path)
          && !(lib.hasSuffix ".sqlite-wal" path)
          && !(lib.hasSuffix ".sqlite-shm" path);
      };
      npmDepsHash = "sha256-bdYE+FQt4EEVHwYGgI8x/A9LM0UPzsUss5ZWGQUyOJk=";
      inherit nodejs;
      dontNpmBuild = true;
      nativeBuildInputs = [python3 pkg-config removeReferencesTo];
      buildInputs = [sqlite];

      postBuild = ''
        pushd node_modules/better-sqlite3
        npm run build-release --offline --nodedir="${nodeSources}"
        find build -type f -exec remove-references-to -t "${nodeSources}" {} \;
        popd
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/app
        cp -r server.js package.json lib public node_modules $out/app/
        if [ -d views ]; then cp -r views $out/app/; fi
        runHook postInstall
      '';
    };

    heimcloud-ops = dockerTools.buildLayeredImage {
      name = "heimcloud-ops";
      tag = "latest";
      contents = [
        nodejs
        app
        cacert
        tzdata
        fakeNss
        dockerTools.caCertificates
      ];
      extraCommands = ''
        mkdir -p data
      '';
      config = {
        WorkingDir = "/app";
        Env = [
          "NODE_ENV=production"
          "PORT=3000"
          "TZ=Europe/Zurich"
          "OPS_DB_PATH=/data/ops.sqlite"
          "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        ];
        ExposedPorts = {
          "3000/tcp" = {};
        };
        Volumes = {
          "/data" = {};
        };
        Cmd = ["${nodejs}/bin/node" "/app/server.js"];
      };
    };
  in {
    packages = {
      inherit heimcloud-ops;
      default = heimcloud-ops;
    };
  };
}
