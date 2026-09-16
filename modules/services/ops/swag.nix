# Ops reverse proxy for SWAG.
# Ingest POST /api/incidents stays under unauthenticated location / (shared-secret in app).
# When admin.enabled && admin.auth && tinyauth is enabled, admin paths get Tinyauth.
{...}: {
  flake.modules.nixos.ops-swag = {
    config,
    lib,
    ...
  }: let
    cfg = config.neo.services.ops;
    tinyauthCfg = config.neo.services.tinyauth or {enabled = false;};
    adminPathRaw = cfg.admin.path or "/admin";
    adminPath =
      if lib.hasSuffix "/" adminPathRaw && adminPathRaw != "/"
      then lib.removeSuffix "/" adminPathRaw
      else adminPathRaw;
    protectAdmin = cfg.admin.enabled && cfg.admin.auth && (tinyauthCfg.enabled or false);
    adminAuthCfg = cfg // {auth = (cfg.auth or {}) // {enabled = true;};};
    adminAuthBlock =
      if protectAdmin
      then lib.neo.authBlock config adminAuthCfg
      else "";
    adminAuthLocations =
      if protectAdmin
      then lib.neo.authLocations config adminAuthCfg
      else "";
    proxyUpstream = ''
          include /config/nginx/proxy.conf;
          include /config/nginx/resolver.conf;
          set $upstream_app ops;
          set $upstream_port 3000;
          set $upstream_proto http;
          proxy_pass $upstream_proto://$upstream_app:$upstream_port;'';
    adminLocations =
      if cfg.admin.enabled
      then ''

        location ${adminPath} {
          ${proxyUpstream}${adminAuthBlock}
        }

        location ${adminPath}/ {
          ${proxyUpstream}${adminAuthBlock}
        }
''
      else "";
  in {
    config.neo.services.ops.proxyConf = lib.mkDefault ''
      server {
        include /config/nginx/listen-https.conf;
        http2 on;
        server_name ${cfg.subdomain}.*;
        include /config/nginx/ssl.conf;
        include /config/nginx/geo-access.conf;
        client_max_body_size 0;
${adminLocations}
        location / {
          include /config/nginx/proxy.conf;
          include /config/nginx/resolver.conf;
          set $upstream_app ops;
          set $upstream_port 3000;
          set $upstream_proto http;
          proxy_pass $upstream_proto://$upstream_app:$upstream_port;
        }
        ${adminAuthLocations}
      }
    '';
  };
}
