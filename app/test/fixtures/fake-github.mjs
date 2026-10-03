// Fake GitHub REST API for the PR-loop tests (child process: the worker's
// wrapper calls are synchronous). State: JSON file (argv[2]); request log:
// JSONL file (argv[3]). Prints the port on stdout.
import http from "node:http";
import fs from "node:fs";

const [stateFile, logFile] = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const s = load();
    const parsed = body ? JSON.parse(body) : undefined;
    fs.appendFileSync(logFile, JSON.stringify({ method: req.method, path: u.pathname + u.search, body: parsed, auth: req.headers.authorization || null }) + "\n");
    const send = (code, data, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${s.token}`) return send(401, { message: "Bad credentials" });
    const page = Number(u.searchParams.get("page") || 1);
    const list = (arr) => send(200, page > 1 ? [] : arr || []);
    let m;
    if (u.pathname === "/user") return send(200, s.user, { "x-oauth-scopes": s.scopes || "public_repo" });
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u.pathname))) return send(200, { full_name: m[1], permissions: { push: (s.pushable || []).includes(m[1]) } });
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname))) {
      const repo = m[1];
      const pulls = Object.values(s.pulls || {}).filter((p) => p.base.repo.full_name === repo);
      if (req.method === "GET") {
        const head = u.searchParams.get("head");
        if (s.hide_list_once > 0) {
          s.hide_list_once -= 1;
          save(s);
          return list([]);
        }
        return list(pulls.filter((p) => `${p.head.repo.owner}:${p.head.ref}` === head));
      }
      const [owner, ref] = parsed.head.split(":");
      if (pulls.some((p) => p.state === "open" && p.head.ref === ref && p.head.repo.owner === owner)) return send(422, { message: "A pull request already exists" });
      const number = (s.next || 1);
      s.next = number + 1;
      const fork = `${owner}/${parsed.head_repo || repo.split("/")[1]}`;
      const pr = {
        number,
        html_url: `https://github.com/${repo}/pull/${number}`,
        state: "open",
        draft: Boolean(parsed.draft),
        merged: false,
        merged_at: null,
        title: parsed.title,
        body: parsed.body,
        user: { login: s.user.login, id: s.user.id, type: "User" },
        head: { ref, sha: "a".repeat(40), repo: { full_name: fork, owner } },
        base: { ref: parsed.base, repo: { full_name: repo } },
        requested_reviewers: [],
      };
      s.pulls = { ...(s.pulls || {}), [number]: pr };
      save(s);
      return send(201, pr);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(u.pathname))) {
      const pr = s.pulls?.[m[1]];
      if (!pr) return send(404, { message: "Not Found" });
      if (req.method === "PATCH") {
        Object.assign(pr, parsed);
        save(s);
      }
      return send(200, pr);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      s.issue_comments ||= {};
      if (req.method === "POST") {
        const c = { id: 900000 + Object.values(s.issue_comments).flat().length, body: parsed.body, user: { login: s.user.login, id: s.user.id, type: "User" }, created_at: new Date().toISOString(), html_url: "https://github.com/x/y/pull/1#c" };
        (s.issue_comments[m[1]] ||= []).push(c);
        save(s);
        return send(201, c);
      }
      return list(s.issue_comments[m[1]]);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/.exec(u.pathname))) return list(s.review_comments?.[m[1]]);
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(u.pathname))) return list(s.reviews?.[m[1]]);
    return send(404, { message: "Not Found" });
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
