/**
 * Ensure anonymous PR payloads never contain seeded customer identifiers.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heimcloud-ops-test-"));
const dbPath = path.join(tmpDir, "ops.sqlite");
process.env.OPS_DB_PATH = dbPath;

const { getDb, upsertIncident, listDistinctCustomerRepoSlugs } = await import(
  "../lib/db.js"
);
const { buildAnonymousPrPayload } = await import("../lib/github.js");
const { redactIdentifyingDetails } = await import("../lib/redact.js");

const SEED_SLUG = "KAKJWG9RM5";
const SEED_HOST = "hattori";
const SEED_EMAIL = "ops-leak@damo4mf20.ch";
const SEED_IP = "203.0.113.77";
const SEED_IPV6 = "2001:db8::abcd";
const SEED_HOME = "/home/damo";
const SEED_FQDN = "box.damo4mf20.ch";
const SEED_PLUGIN = "github:heimcloud/customers/KAKJWG9RM5";

before(() => {
  getDb();
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("redactIdentifyingDetails strips seeded identifiers", () => {
  const dirty = [
    `slug=${SEED_SLUG}`,
    `host=${SEED_HOST}`,
    `email=${SEED_EMAIL}`,
    `ip=${SEED_IP}`,
    `ipv6=${SEED_IPV6}`,
    `home=${SEED_HOME}/src`,
    `fqdn=${SEED_FQDN}`,
    `plugin=${SEED_PLUGIN}`,
    `image=docker.io/searxng/searxng:latest`,
    `sha=c51ec63a3d9bfc36e48e49fa49883cc01b98d5bd`,
  ].join("\n");

  const clean = redactIdentifyingDetails(dirty, { knownSlugs: [SEED_SLUG] });
  for (const bad of [
    SEED_SLUG,
    SEED_HOST,
    SEED_EMAIL,
    SEED_IP,
    SEED_IPV6,
    SEED_HOME,
    SEED_FQDN,
    SEED_PLUGIN,
  ]) {
    assert.equal(clean.includes(bad), false, `still contains ${bad}: ${clean}`);
  }
  assert.match(clean, /docker\.io\/searxng\/searxng:latest/);
  assert.match(clean, /c51ec63a3d9bfc36e48e49fa49883cc01b98d5bd/);
});

test("buildAnonymousPrPayload never leaks seeded slug or identifiers", () => {
  const logs = [
    `Docker update on ${SEED_HOST} (${SEED_FQDN})`,
    `customer_repo_slug: ${SEED_SLUG}`,
    `contact ${SEED_EMAIL} from ${SEED_IP} / ${SEED_IPV6}`,
    `path ${SEED_HOME}/neo`,
    `plugin ${SEED_PLUGIN}`,
    `Image docker.io/searxng/searxng:latest`,
    `Missing engines: adobe_stock, reddit`,
  ].join("\n");

  const { incident } = upsertIncident({
    report_hash:
      "c51ec63a3d9bfc36e48e49fa49883cc01b98d5bd46cd05d9899914ed9530f771",
    neo_version: `neo 0.1.0 / nixos-system-${SEED_HOST}-26.05.20260922.1bc55b9`,
    unit: "neo-docker-updater / docker-searxng",
    logs_excerpt: logs,
    customer_repo_slug: SEED_SLUG,
    severity: "warning",
    target_hint: `${SEED_HOST} searxng stale engines`,
    plugin_urls: [SEED_PLUGIN],
  });

  assert.ok(incident.id);
  assert.deepEqual(listDistinctCustomerRepoSlugs(), [SEED_SLUG]);

  const payload = buildAnonymousPrPayload(incident);
  const blob = `${payload.title}\n${payload.body}`;

  const forbidden = [
    SEED_SLUG,
    SEED_HOST,
    SEED_EMAIL,
    SEED_IP,
    SEED_IPV6,
    SEED_HOME,
    SEED_FQDN,
    "damo4mf20.ch",
    SEED_PLUGIN,
    "github:heimcloud/customers/",
  ];
  // Field names may appear in redacted logs; values must not.
  assert.equal(blob.includes("target_hint:"), false);
  for (const bad of forbidden) {
    assert.equal(
      blob.toLowerCase().includes(bad.toLowerCase()),
      false,
      `PR payload still contains ${bad}:\n${blob}`,
    );
  }

  assert.match(payload.title, /incident #/);
  assert.match(payload.body, /c51ec63a3d9b/);
  assert.match(payload.body, /warning/);
  assert.match(payload.body, /docker-searxng/);
  assert.match(payload.body, /docker\.io\/searxng\/searxng:latest/);
});
